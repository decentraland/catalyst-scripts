import { fetchJson, getEntityFromPointers } from './common/Requests';
import { Entity, Pointer, EntityId } from './common/types';
import AWS from 'aws-sdk'
import * as fs from 'fs';
import {createCanvas} from 'canvas';

const RED_COMPONENT   = 0
const GREEN_COMPONENT = 1
const BLUE_COMPONENT  = 2
const ALPHA_COMPONENT = 3

async function run() {
    const accessKey   = process.env.SQS_ACCESS_KEY ?? ''
    const secretKey   = process.env.SQS_SECRET_KEY ?? ''
    const sqsQueueUrl = process.env.SQS_QUEUE_URL  ?? ''
    const enqueueScenes = (process.env.ENQUEUE_SCENES  ?? 'false').toLowerCase() === 'true'
    console.log("enqueueScenes: ", enqueueScenes)

    const bucketKeys: string[] = await retrieveAllBucketKeys()
    console.log(`Total bucket keys: ${bucketKeys.length}`)

    const scenesData: SceneData[] = await getScenesData()
    console.log(`Total scenes: ${scenesData.length}`)

    const margin = 10
    const minPos = -150
    const maxPos = 150
    const worldSize = maxPos - minPos
    const canvasSize = 2 * margin + worldSize
    const canvas = createCanvas(canvasSize, canvasSize)
    const context = canvas.getContext('2d')

    context.fillStyle = '#ccc'
    context.fillRect(0, 0, canvasSize, canvasSize)

    context.fillStyle = '#fff'
    context.fillRect(margin, margin, worldSize, worldSize)

    console.log("Finding scenes with missing hashes...")
    const scenesWithMissingHashes: EntityId[] = []
    scenesData.forEach(sceneData => {
        const missingHashes = sceneData.gltfs.filter(hash => !bucketKeys.includes(hash))
        const pixel = context.createImageData(1,1)
        pixel.data[ALPHA_COMPONENT] = 255
        if (missingHashes.length > 0) {
            logSceneAndMissingHashes(sceneData, missingHashes)
            scenesWithMissingHashes.push(sceneData.id)
            pixel.data[RED_COMPONENT] = 10 * missingHashes.length;
        } else {
            pixel.data[GREEN_COMPONENT] = 100;
        }
        sceneData.pointers.forEach(pointer => {
            const [px,py] = pointer.split(',')
            const x = margin + parseInt(px) - minPos
            const y = margin + parseInt(py) - minPos
            context.putImageData( pixel, x, y );
        })
    });
    console.log(`Scenes with missing hashes: ${scenesWithMissingHashes.length}`)

    const buffer = canvas.toBuffer('image/png')
    fs.writeFileSync('./image.png', buffer)

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

function logSceneAndMissingHashes(sceneData: SceneData, missingHashes: string[]) {
    console.log(`${sceneData.id} [${sceneData.pointers}]`)
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

type DeployedEntity = {
    entityId: string,
    pointers: string[],
    content : {
        key: string,
        hash: string,
    }[]
}

type SceneData = {
    id: string,
    pointers: string[],
    gltfs: string[]

}
async function getScenesData(): Promise<SceneData[]> {
    return localCache<SceneData[]>(async () => {
            const batchStart = 0
            const batchEnd   = 25000
            const batchStep  = 500
            const batchArray = [...Array((batchEnd-batchStart)/batchStep).keys()]
            var scenesData: SceneData[] = []

            console.log("Retrieving scenes info...")
            await Promise.all(batchArray.map(async batchItem => {
                const offset = batchItem * batchStep
                const deploymentsResponse = await fetchJson('https://peer.decentraland.org/content', `/deployments?entityType=scene&onlyCurrentlyPointed=true&offset=${offset}`)
                const entities: DeployedEntity[] = deploymentsResponse.deployments
                const partialScenesData: SceneData[] = entities
                    .filter(entity => entity.content)
                    .map(entity => { return {
                        id: entity.entityId,
                        pointers: entity.pointers,
                        gltfs: entity.content.filter(item => isGltf(item.key)).map(item => item.hash)
                    }})
                scenesData.push(...partialScenesData)
                console.log(scenesData.length)
            }))
            console.log(`Scenes info retrieved. Retrieved ${scenesData.length} scenes.`)
            return scenesData
        }, "scenes-data.json")
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
