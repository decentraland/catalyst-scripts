import { getEntityFromPointers } from './common/Requests';
import { Entity, Pointer, EntityId } from './common/types';
import AWS from 'aws-sdk'
import * as fs from 'fs';

async function run() {
    const accessKey   = process.env.SQS_ACCESS_KEY ?? ''
    const secretKey   = process.env.SQS_SECRET_KEY ?? ''
    const sqsQueueUrl = process.env.SQS_QUEUE_URL  ?? ''

    const bucketKeys: string[] = await retrieveAllBucketKeys()
    console.log(`Total bucket keys: ${bucketKeys.length}`)

    const allGltf: Map<EntityId, string[]> = await getAllGltfsByScene()
    console.log(`Total scenes: ${allGltf.size}`)

    console.log("Finding scenes with missing hashes...")
    const scenesWithMissingHashes: EntityId[] = []
    allGltf.forEach((gltfHashes: string[], sceneId: EntityId) => {
        const hasMissingHashes = gltfHashes.filter(hash => !bucketKeys.includes(hash)).length > 0
        if (hasMissingHashes) {
            scenesWithMissingHashes.push(sceneId)
        }
    });
    console.log(`Scenes with missing hashes: ${scenesWithMissingHashes.length}`)

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

    console.log("Done.")
}

async function sendSqsMessage(sqsClient: AWS.SQS, sqsQueueUrl: string, sceneId: string): Promise<string|undefined> {
    const messageBody = {type: 'scene', id: sceneId}
    const messageRequest: AWS.SQS.SendMessageRequest = {
        QueueUrl: sqsQueueUrl,
        MessageBody: JSON.stringify(messageBody),
    }
    return new Promise((resolve) => {
        try {
            sqsClient.sendMessage(messageRequest, (error: AWS.AWSError, data: AWS.SQS.Types.SendMessageResult) => {
                if (error) {
                    console.error(`Error sending message to SQS (callback). Scene: ${sceneId}.`, error);
                    return resolve(undefined)
                }
                console.log(`Send Message successfull: ${data.MessageId}`)
                return resolve(data.MessageId)
            })
        } catch (error) {
            console.error(`Error sending message to SQS. Scene: ${sceneId}.`, error);
            return resolve(undefined)
        }
    })
}

async function getAllGltfsByScene(): Promise<Map<EntityId, string[]>> {
    var gltfsByScene: Map<EntityId, string[]> = new Map()

    try {
        gltfsByScene = new Map(JSON.parse(fs.readFileSync("all-gltfs-by-scene.json").toString()))
    } catch {
        console.log("GLTFs are not cached, retrieving them from peer.decentraland.org/content...")
    }

    if (gltfsByScene.size===0) {
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

        fs.writeFileSync("all-gltfs-by-scene.json", JSON.stringify(Array.from(gltfsByScene)));

    }

    return gltfsByScene
}

function isGltf(file:String): boolean {
    return file.endsWith('.glb') || file.endsWith('.gltf')
}

async function retrieveAllBucketKeys(): Promise<string[]> {
    var allKeys: string[] = []

    try {
        allKeys = JSON.parse(fs.readFileSync("all-keys-in-bucket.json").toString())
    } catch {
        console.log("Keys are not cached, retrieving them from S3")
    }
    if (allKeys.length===0) {
        const s3Client: AWS.S3 = new AWS.S3()
        var continuationToken: string|undefined = undefined
        do {
            const page = await retrieveBucketKeysPage(s3Client, continuationToken)
            allKeys.push(...page.keys)
            console.log(`All Keys length: ${allKeys.length}`)
            continuationToken = page.continuationToken
        } while(continuationToken)
        console.log(`Finished: ${allKeys.length}`)

        fs.writeFileSync("all-keys-in-bucket.json", JSON.stringify(allKeys));
    }

    return allKeys
}

type KeysPage = { keys: string[], continuationToken: string|undefined }
async function retrieveBucketKeysPage(s3Client: AWS.S3, continuationToken:string|undefined): Promise<KeysPage> {
    const request: AWS.S3.Types.ListObjectsV2Request = {
        Bucket: "content-assets-as-bundle.decentraland.org",
        ContinuationToken: continuationToken
    }
    return new Promise((resolve) => {
        s3Client.listObjectsV2(request, (error: AWS.AWSError, data: AWS.S3.Types.ListObjectsV2Output) => {
            if (error) {
                console.error(`Error retrieving keys from S3. Continuation Token: ${continuationToken}`, error);
                return resolve(undefined)
            }
            return resolve({
                keys: data.Contents ? data.Contents.filter(object => object.Key).map(object => object.Key as string) : [],
                continuationToken: data.NextContinuationToken
            })
        })
    })
}

run().then(() => console.log("Done!"))
