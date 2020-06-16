import { fetchJson, getEntityFromPointers } from './common/Requests';
import { Entity, Pointer, EntityId } from './common/types';
import AWS from 'aws-sdk'
import * as fs from 'fs';

async function run() {
    const accessKey   = process.env.SQS_ACCESS_KEY ?? ''
    const secretKey   = process.env.SQS_SECRET_KEY ?? ''
    const sqsQueueUrl = process.env.SQS_QUEUE_URL  ?? ''
    const enqueueScenes = (process.env.ENQUEUE_SCENES  ?? 'false').toLowerCase() === 'true'
    console.log("enqueueScenes: ", enqueueScenes)

    const bucketKeys: string[] = await retrieveAllBucketKeys()
    console.log(`Total bucket keys: ${bucketKeys.length}`)

    const allGltf: Map<EntityId, string[]> = await getAllGltfsByScene()
    console.log(`Total scenes: ${allGltf.size}`)

    console.log("Finding scenes with missing hashes...")
    const scenesWithMissingHashes: EntityId[] = []
    allGltf.forEach((gltfHashes: string[], sceneId: EntityId) => {
        const missingHashes = gltfHashes.filter(hash => !bucketKeys.includes(hash))
        if (missingHashes.length > 0) {
            logSceneAndMissingHashes(sceneId, missingHashes)
            scenesWithMissingHashes.push(sceneId)
        }
    });
    console.log(`Scenes with missing hashes: ${scenesWithMissingHashes.length}`)

    if (enqueueScenes) {
        console.log("Sending those scenes to the migrator...")
        try {
            const sqsClient = new AWS.SQS({region: "us-east-1", credentials: new AWS.Credentials(accessKey, secretKey)})
            console.log("SQS cliente created...")
            await Promise.all(scenesWithMissingHashes.map(async sceneId => {
                console.log(`Sending SceneId: ${sceneId}...`)
                const messageId = await sendSqsMessage(sqsClient, sqsQueueUrl, sceneId)
                console.log(`Sent SceneId: ${sceneId}. MessageId: ${messageId}`)
            }))
        } catch (error) {
            console.error(error)
        }
    }

    console.log("Done.")
}

function logSceneAndMissingHashes(sceneId: string, missingHashes: string[]) {
    console.log(sceneId)
    missingHashes.forEach(hash => {
        console.log("   " + hash)
    })
}

async function sendSqsMessage(sqsClient: AWS.SQS, sqsQueueUrl: string, sceneId: string): Promise<string|undefined> {
    const messageBody = {type: 'scene', id: sceneId}
    const messageRequest: AWS.SQS.SendMessageRequest = {
        QueueUrl: sqsQueueUrl,
        MessageBody: JSON.stringify(messageBody),
    }
    return new Promise((resolve, reject) => {
        try {
            sqsClient.sendMessage(messageRequest, (error: AWS.AWSError, data: AWS.SQS.Types.SendMessageResult) => {
                if (error) {
                    console.error(`Error sending message to SQS (callback). Scene: ${sceneId}.`, error);
                    return reject(undefined)
                }
                console.log(`Send Message successfull: ${data.MessageId}`)
                return resolve(data.MessageId)
            })
        } catch (error) {
            console.error(`Error sending message to SQS. Scene: ${sceneId}.`, error);
            return reject(undefined)
        }
    })
}

async function getAllGltfsBySceneOld(): Promise<Map<EntityId, string[]>> {
    return localCache<Map<EntityId, string[]>>(async () => {
            var gltfsByScene: Map<EntityId, string[]> = new Map()

            const xStart = -150
            const xEnd   =  150
            const xStep  =    5

            const yStart = -150
            const yEnd   =  150
            const yStep  =    5

            const pointerBatches: Pointer[][] = []
            console.log("Creating pointers...")
            for(var xBlockStart=xStart; xBlockStart<xEnd+1; xBlockStart+=xStep) {
                for(var yBlockStart=yStart; yBlockStart<yEnd+1; yBlockStart+=yStep) {
                    var pointers: Pointer[] = []
                    for(var x=xBlockStart; x<Math.min(xBlockStart+xStep, xEnd+1); x++) {
                        for(var y=yBlockStart; y<Math.min(yBlockStart+yStep, yEnd+1); y++) {
                            pointers.push(`${x},${y}`)
                        }
                    }
                    pointerBatches.push(pointers)
                }
            }
            console.log(`Pointers done. Calculated ${pointerBatches.length} batches.`)

            console.log("Retrieving scenes info...")
            await Promise.all(pointerBatches.map(async pointers => {
                const entities: Entity[] = await getEntityFromPointers('https://peer.decentraland.org/content', 'scene', pointers)
                entities.forEach(entity => {
                    if (entity.content) {
                        const gltfs: string[] = entity.content.filter(item => isGltf(item.file)).map(item => item.hash)
                        gltfsByScene.set(entity.id, gltfs)
                    }
                })
                console.log(gltfsByScene.size)
            }))
            console.log(`Scenes info retrieved. Retrieved ${gltfsByScene.size} scenes.`)
            return gltfsByScene
        },
        "all-gltfs-by-scene.json",
        (str) => new Map(JSON.parse(str)),
        (map) => JSON.stringify(Array.from(map))
    )
}

type DeployedEntity = {
    entityId: string,
    content : {
        key: string,
        hash: string,
    }[]
}

async function getAllGltfsByScene(): Promise<Map<EntityId, string[]>> {
    return localCache<Map<EntityId, string[]>>(async () => {
            const batchStart = 0
            const batchEnd   = 25000
            const batchStep  = 500
            const batchArray = [...Array((batchEnd-batchStart)/batchStep).keys()]
            var gltfsByScene: Map<EntityId, string[]> = new Map()

            console.log("Retrieving scenes info...")
            await Promise.all(batchArray.map(async batchItem => {
                const offset = batchItem * batchStep
                const deploymentsResponse = await fetchJson('https://peer.decentraland.org/content', `/deployments?entityType=scene&onlyCurrentlyPointed=true&offset=${offset}`)
                const entities: DeployedEntity[] = deploymentsResponse.deployments
                entities.forEach(entity => {
                    if (entity.content) {
                        const gltfs: string[] = entity.content.filter(item => isGltf(item.key)).map(item => item.hash)
                        gltfsByScene.set(entity.entityId, gltfs)
                    }
                })
                console.log(gltfsByScene.size)
            }))
            console.log(`Scenes info retrieved. Retrieved ${gltfsByScene.size} scenes.`)
            return gltfsByScene
        },
        "all-gltfs-by-scene.json",
        (str) => new Map(JSON.parse(str)),
        (map) => JSON.stringify(Array.from(map))
    )
}

function isGltf(file:String): boolean {
    return file.endsWith('.glb') || file.endsWith('.gltf')
}

async function retrieveAllBucketKeys(): Promise<string[]> {
    return localCache<string[]>(async () => {
        const allKeys: string[] = []
        const s3Client: AWS.S3 = new AWS.S3()
        var continuationToken: string|undefined = undefined
        do {
            const page = await retrieveBucketKeysPage(s3Client, continuationToken)
            allKeys.push(...page.keys)
            console.log(`All Keys length: ${allKeys.length}`)
            continuationToken = page.continuationToken
        } while(continuationToken)
        console.log(`Finished: ${allKeys.length}`)
        return allKeys
    }, "all-keys-in-bucket.json")
}

type KeysPage = { keys: string[], continuationToken: string|undefined }
async function retrieveBucketKeysPage(s3Client: AWS.S3, continuationToken:string|undefined): Promise<KeysPage> {
    const request: AWS.S3.Types.ListObjectsV2Request = {
        Bucket: "content-assets-as-bundle.decentraland.org",
        ContinuationToken: continuationToken
    }
    return new Promise((resolve, reject) => {
        s3Client.listObjectsV2(request, (error: AWS.AWSError, data: AWS.S3.Types.ListObjectsV2Output) => {
            if (error) {
                console.error(`Error retrieving keys from S3. Continuation Token: ${continuationToken}`, error);
                return reject(undefined)
            }
            return resolve({
                keys: data.Contents ? data.Contents.filter(object => object.Key).map(object => object.Key as string) : [],
                continuationToken: data.NextContinuationToken
            })
        })
    })
}

async function localCache<T>(operation: () => Promise<T>, fileName: string, fromString: (string) => T = JSON.parse, toString: (T) => string = JSON.stringify): Promise<T> {
    try {
        return fromString(fs.readFileSync(fileName).toString())
    } catch {
        console.log(`File ${fileName} could no be read or parsed, performing operation...`)
    }
    const value: T = await operation()
    fs.writeFileSync(fileName, toString(value));
    return value
}

run().then(() => console.log("Done!"))
