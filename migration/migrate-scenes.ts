import { ArgumentParser } from "argparse"
import fs from "fs"
import { Hashing, FileHash } from "./utils/Hashing"
import { deploy, executeWithProgressBar, log, buildEntityFile, fetchJson, DeployData, ContentFile, failed, downloadFile, clearLogFiles, shuffleArray, current, deployDefault, GLOBAL } from './utils/Helper';

const DEFAULT_SCENES_DIR = 'migration/resources/DefaultScenes'
const FROM_X: number = -150
const TO_X: number = 150
const FROM_Y: number = -150
const TO_Y: number = 150

const toMigrate: Set<string> = new Set()
let sentContent: Map<string, FileHash> = new Map()

async function run() {

    const parser = new ArgumentParser({ addHelp: true });
    parser.addArgument('serverAddress', { help: 'The address of the server where the profiles will be deployed'});
    parser.addArgument('identityFilePath', { help: 'The path to the json file where the address and private key are, to use for deployment'});
    parser.addArgument('sourceServer', { help: 'URL of the server to copy entities from'});
    parser.addArgument(['-o', '--output'], { help: 'The path to directory where logs will be stored', defaultValue: ""});
    parser.addArgument(['--retries'], { help: 'Number of retries when an action fails', type: 'int', defaultValue: 5 });
    parser.addArgument(['--concurrency'], { help: 'Number of workers that will execute concurrently', type: 'int', defaultValue: 15 });
    parser.addArgument(['--scenes'], { help: 'Specific scenes to migrate', metavar: 'N', nargs: '+' });

    const args = parser.parseArgs();

    // Set global vars
    GLOBAL.identityFilePath = args.identityFilePath
    GLOBAL.outputDir = args.output.endsWith("/") ? args.output : (args.output !== "" ? args.output + '/' : "")
    GLOBAL.retries = args.retries
    GLOBAL.concurrency = args.concurrency

    clearLogFiles()
    await log("Starting scene migration")
    await migrateDefault(args.serverAddress)

    const allScenes: Map<RootCid, Set<Parcel>> = await getAllScenes(args.sourceServer)
    const scenes = new Map(Array.from(allScenes.entries()).filter(([rootCid]) => !args.scenes || args.scenes.includes(rootCid)))
    for (const scene of scenes.keys()) toMigrate.add(scene)
    const interval = setInterval(async () => { await current(toMigrate) }, 10000)
    await fetchAndMigrateToV3(args.sourceServer, scenes, args.serverAddress);
    fs.writeFileSync(GLOBAL.outputDir + "mapped.txt", Buffer.from(JSON.stringify(Array.from(sentContent.entries()))))
    clearInterval(interval)
}

async function fetchAndMigrateToV3(v2ServerAddress: string, allScenes: Map<string, Set<string>>, serverAddress: string) {
    console.log(`Fetching all necessary data from V2 and migrating to V3`);

    const scenes = Array.from(allScenes.entries());
    shuffleArray(scenes)
    // Migrate everything to V3
    await executeWithProgressBar('Migrating and deploying', scenes, async ([rootCid, parcels]) => {
        try {
            const alreadyDeployed = await checkIfRootCidAlreadyDeployed(serverAddress, rootCid, parcels)
            if (!alreadyDeployed || process.env.CHECK_HASH_ANYWAY) {
                const deployData = await fetchFromV2AndMigrateToV3(v2ServerAddress, rootCid, parcels)
                if (deployData && !alreadyDeployed) {
                    await deploy(serverAddress, rootCid, deployData)
                }
            } else {
                await log(`${rootCid} already deployed`)
            }
        } catch (error) {
            await log(error)
            await failed(`Failed to deploy scene with rootCid: ${rootCid}`)
        }
        toMigrate.delete(rootCid)
    });
}

async function migrateDefault(serverAddress: string) {
    const sceneFolders = fs.readdirSync(DEFAULT_SCENES_DIR).filter(file => !file.includes("DS_Store"))

    for (const sceneFolder of sceneFolders) {
        const entities: EntitiesResponse = await fetchJson(serverAddress, `/entities/scenes?pointer=${sceneFolder}`);

        if (entities.length > 0) {
            await log(`${sceneFolder} already deployed`)
        } else {
            const contentFiles: Map<string, Buffer> = new Map(fs.readdirSync(`${DEFAULT_SCENES_DIR}/${sceneFolder}`)
                .filter(file => !file.includes("DS_Store"))
                .map(fileName => [fileName, fs.readFileSync(`${DEFAULT_SCENES_DIR}/${sceneFolder}/${fileName}`)]))

            // Update the timestamp
            const entityFile = contentFiles.get("entity.json") as Buffer
            const entityJson = JSON.parse(entityFile.toString())
            entityJson.timestamp = Date.now()
            const entityBuffer = Buffer.from(JSON.stringify(entityJson))
            contentFiles.set("entity.json", entityBuffer)

            // Generate entityId
            const entityId = await Hashing.calculateBufferHash(entityBuffer)

            await deployDefault(serverAddress, entityId, contentFiles)
            await log(`Deployed default ${entityId}`)
        }
    }
}

async function checkIfRootCidAlreadyDeployed(serverAddress: string, rootCid: RootCid, parcels: Set<Parcel>): Promise<boolean> {
    const query = "fields=id&pointer=" + Array.from(parcels.values()).join("&pointer=")
    const entitiesResponse: EntitiesResponse = await fetchJson(serverAddress, `/entities/scenes?${query}`)
    if (entitiesResponse.length != 1) {
        return false
    } else {
        const { id }  = entitiesResponse[0]
        const auditResponse: AuditResponse = await fetchJson(serverAddress, `/audit/scenes/${id}`)
        if (auditResponse.originalMetadata) {
            return rootCid === auditResponse.originalMetadata.data.originalRootCid
        } else if (auditResponse.version > "v2") {
            await log(`RootCid ${rootCid} has a higher version already deployed`)
            return true
        } else {
            return false
        }
    }
}

/**
 * This method fetches all V2 data necessary and migrated it to a V3 format. It does not perform the deploy
 */
async function fetchFromV2AndMigrateToV3(v2ServerAddress: string, rootCid: RootCid, parcels: Set<Parcel>): Promise<DeployData | undefined> {
    // Fetch audit data
    const oneParcel = parcels.values().next().value
    const [x, y] = oneParcel.split(',')
    const {pubkey: author, root_cid, signature, timestamp}: ValidateResponse = await fetchJson(v2ServerAddress, `/validate?x=${x}&y=${y}`)
    const migrationData: MigrationData = { originalRootCid: root_cid, originalAuthor: author, originalSignature: signature, originalTimestamp: timestamp }

    // Check if root_cid is the since a deployment could have happened before we checked here
    if (root_cid === rootCid) {
        const [entityId, entityFile, otherFiles] = await migrateSceneToV3(v2ServerAddress, rootCid, parcels)
        return {entityId, entityFile, otherFiles, migrationData}
    } else {
        return undefined
    }
}

async function migrateSceneToV3(v2ServerAddress: string, rootCid: RootCid, parcels: Set<Parcel>): Promise<[string, ContentFile, Map<FileHash, Buffer>]> {
    // Fetch parcel info
    const response: ParcelInfoResponse = await fetchJson(v2ServerAddress, `/parcel_info?cids=${rootCid}`)

    // Organize scene content
    const fileToV2Hash: Map<string, string> = new Map(response.data[0].content.contents
        .map(({file, hash}) => [file, hash]))

    // Check if we already mapped and set content to v3
    const alreadyMappedHashes: {file: string, hash: FileHash}[] = Array.from(fileToV2Hash.entries())
        .map(([file, v2Hash]) => [file, sentContent.get(v2Hash)])
        .filter(([, v3Hash]) => !!v3Hash)
        .map(([file, v3Hash]) => ({file, hash: v3Hash}) as ({file: string, hash: FileHash}))

    // Download new content
    await log(`Downloading content for ${rootCid}`)
    const filesToDownload = Array.from(fileToV2Hash.entries())
        .filter(([, v2Hash]) => !sentContent.has(v2Hash));
    const downloadedContentEntries:[string, Buffer][] = []
    for (const [file, v2Hash] of filesToDownload) {
        const buffer = await downloadContentFile(v2ServerAddress, v2Hash)
        downloadedContentEntries.push([file, buffer])
    }
    const AuditInfoV2: Map<string, Buffer> = new Map(await Promise.all(downloadedContentEntries))
    await log(`Downloaded all content for ${rootCid}`)

    // Re-hash the new content
    const downloadedContentHashes: {file: string, hash: FileHash}[] = await Hashing.calculateHashes(AuditInfoV2)

    // Make sure that the 'scene.json' is in the content
    const sceneJsonBuffer: Buffer | undefined = AuditInfoV2.get("scene.json")
    if (!sceneJsonBuffer) {
        throw new Error(`Couldn't find the 'scene.json' for scene with root_cid=${rootCid}`)
    }

    // Add the new content to the global map, so we can avoid it next time
    downloadedContentHashes.forEach(({file, hash}) => {
        const v2Hash = fileToV2Hash.get(file) as string
        sentContent.set(v2Hash, hash)
    })

    // Join new content and already sent content
    const content = [...alreadyMappedHashes, ...downloadedContentHashes]

    // Build entity file
    const [entityId, entityFile] = await buildEntityFile("scene", [...parcels], Date.now(), content, JSON.parse(sceneJsonBuffer.toString()))

    // Build v3Hash => Buffer map
    const downloadedFiles: Map<FileHash, Buffer> = new Map(downloadedContentHashes.map(({ file, hash }) => [hash, AuditInfoV2.get(file) as Buffer]))

    return [entityId, entityFile, downloadedFiles]
}

async function getAllScenes(v2ServerAddress: string): Promise<Map<RootCid, Set<Parcel>>> {
    const result: Map<RootCid, Set<Parcel>> = new Map()

    const parcelsBlocks: {x1: number, y1: number, x2: number, y2: number}[] = []

    // Create blocks of parcels to request the content server
    for (let x1 = FROM_X; x1 <= TO_X; x1 += 50) {
        for (let y1 = FROM_Y; y1 <= TO_Y; y1 += 4) {
            const x2 = Math.min(TO_X, x1 + 49)
            const y2 = Math.min(TO_Y, y1 + 3)
            parcelsBlocks.push({x1, y1, x2, y2})
        }
    }

    // Gather all scene data
    const pairsArrays = await executeWithProgressBar('Gathering scenes', parcelsBlocks, async ({x1, y1, x2, y2}) => {
        const response: ScenesResponse = await fetchJson(v2ServerAddress, `/scenes?x1=${x1}&y1=${y1}&x2=${x2}&y2=${y2}`)
        return response.data.map(({ parcel_id, root_cid }) => ({ parcel_id, root_cid }))
    })

    // Iterate through the results, and create a map root_cid => parcels
    for (const array of pairsArrays) {
        for (const {parcel_id, root_cid} of array) {
            if (!result.has(root_cid)) {
                result.set(root_cid, new Set())
            }
            result.get(root_cid)?.add(parcel_id)
        }
    }
    return result
}

function downloadContentFile(v2ServerAddress: string, hash: string): Promise<Buffer> {
    return downloadFile(`${v2ServerAddress}/contents/${hash}`)
}

type MigrationData = {
    originalRootCid: RootCid,
    originalAuthor: string,
    originalSignature: string,
    originalTimestamp: number,
}

type Parcel = string
type RootCid = string

// V3
type AuditResponse = {
    version: string,
    originalMetadata?: {
        data: {
            originalRootCid: RootCid,
        }
    }
}

type EntitiesResponse = {
    id: string
}[]

// V2
type ValidateResponse = {
    pubkey: string,
    root_cid: RootCid,
    signature: string,
    timestamp: number,
}

type ParcelInfoResponse = {
    data: {
        root_cid: RootCid
        content: {
            contents: {
                file: string,
                hash: string,
            }[],
        }
    }[]
}

type ScenesResponse = {
    data: {
        parcel_id: Parcel,
        root_cid: RootCid,
    }[]
}

run().then(() => console.log("Done!"))