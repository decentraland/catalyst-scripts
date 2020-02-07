import { ArgumentParser } from "argparse"
import csv from "csvtojson"
import { Hashing, FileHash } from "./utils/Hashing"
import { deploy, executeWithProgressBar, log, buildEntityFile, fetchJson, clearLogFiles, ContentFile, downloadFile, failed, DeployData, GLOBAL } from './utils/Helper';

const CSV_PATH = 'migration/resources/profiles.csv'

async function run() {
    const parser = new ArgumentParser({ addHelp: true });
    parser.addArgument('serverAddress', { help: 'The address of the server where the profiles will be deployed'});
    parser.addArgument('identityFilePath', { help: 'The path to the json file where the address and private key are, to use for deployment'});
    parser.addArgument(['-o', '--output'], { help: 'The path to directory where logs will be stored', defaultValue: ""});
    parser.addArgument(['--retries'], { help: 'Number of retries when an action fails', type: 'int', defaultValue: 5 });
    parser.addArgument(['--concurrency'], { help: 'Number of workers that will execute concurrently', type: 'int', defaultValue: 15 });
    parser.addArgument(['--profiles'], { help: 'Specific profiles to migrate', metavar: 'N', nargs: '+' });

    const args = parser.parseArgs();

    // Set global vars
    GLOBAL.identityFilePath = args.identityFilePath
    GLOBAL.outputDir = args.output.endsWith("/") ? args.output : (args.output !== "" ? args.output + '/' : "")
    GLOBAL.retries = args.retries
    GLOBAL.concurrency = args.concurrency

    const json = await csv().fromFile(CSV_PATH)
    const nonGuest = json.filter(json => !!json['eth_address'])
    console.log(`${json.length - nonGuest.length} guest profiles ignored`)
    const specific = nonGuest.filter(json => !args.profiles || args.profiles.includes(json['eth_address']))

    clearLogFiles()
    await log("Starting profiles migration")
    await migrateToV3(specific, args.serverAddress);
}

async function migrateToV3(json: any[], serverAddress: string) {
    // Migrate everything to V3
    await executeWithProgressBar('Migrating and deploying', json, async (json) => {
        const name: string = json['name']
        const description: string = json['description']
        const address: string = json['eth_address']
        const avatar: Avatar = JSON.parse(json['avatar'])
        const version: number = parseInt(json['version'])

        try {
            const alreadyDeployed = await checkIfVersionAlreadyDeployed(serverAddress, address, version)
            if (!alreadyDeployed) {
                const deployData = await fetchFromV2AndMigrateToV3(address, name, description, avatar, version)
                if (deployData) {
                    await deploy(serverAddress, address, deployData)
                }
            } else {
                await log(`${address}, version ${version} already deployed`)
            }
        } catch(error) {
           await failed(`Failed to migrate profile with address ${address}`)
        }
    });
}

async function checkIfVersionAlreadyDeployed(serverAddress: string, ethAddress: string, version: number): Promise<boolean> {
    const entitiesResponse: EntitiesResponse = await fetchJson(serverAddress, `/entities/profile?pointer=${ethAddress}`)
    if (entitiesResponse.length != 1) {
        return false
    } else {
        const { id }  = entitiesResponse[0]
        const auditResponse: AuditResponse = await fetchJson(serverAddress, `/audit/profile/${id}`)
        if (auditResponse.originalMetadata) {
            return version === auditResponse.originalMetadata.data.originalVersion
        } else if (auditResponse.version > "v2") {
                await log(`Address ${ethAddress} has a higher version already deployed`)
                return true
        } else {
            return false
        }
    }
}

async function fetchFromV2AndMigrateToV3(ethAddress: string, name: string, description: string, avatar: Avatar, version: number): Promise<DeployData | undefined> {
    const migrationData: MigrationData = { originalVersion: version }
    const [entityId, entityFile, otherFiles] = await migrateProfileToV3(ethAddress, name, description, avatar)
    return {entityId, entityFile, otherFiles, migrationData}
}

async function migrateProfileToV3(ethAddress: string, name: string, description: string, avatar: Avatar): Promise<[string, ContentFile, Map<FileHash, Buffer>]> {
    await log(`Downloading snapshots for ${ethAddress}`)
    const bodySnapshot = avatar.snapshots.body
    const bodyBuffer = await downloadFile(bodySnapshot, ethAddress)
    const bodyHash = await Hashing.calculateBufferHash(bodyBuffer)

    const faceSnapshot = avatar.snapshots.face
    const faceBuffer = await downloadFile(faceSnapshot, ethAddress)
    const faceHash = await Hashing.calculateBufferHash(faceBuffer)
    await log(`Downloaded all snapshots for ${ethAddress}`)

    // Build content
    const content = [{file: "face.png", hash: faceHash}, {file: "body.png", hash: bodyHash}]

    // Build new avatar
    const newAvatar: Avatar = {
        ...avatar,
        snapshots: {
            face: faceHash,
            body: bodyHash,
        },
    }

    // Prepare metadata
    const metadata: V3Metadata = {
        avatars: [{
            name,
            description,
            avatar: newAvatar
        }]
    }

    // Build entity file
    const [entityId, entityFile] = await buildEntityFile("profile", [ethAddress], Date.now(), content, metadata)

    // Build hash => Buffer map
    const otherFiles: Map<FileHash, Buffer> = new Map([[faceHash, faceBuffer], [bodyHash, bodyBuffer]])

    return [entityId, entityFile, otherFiles]
}

type MigrationData = {
    originalVersion: number,
}

// V3
type AuditResponse = {
    version: string,
    originalMetadata?: {
        data: {
            originalVersion: number,
        }
    }
}

type EntitiesResponse = {
    id: string
}[]

type V3Metadata = {
    avatars: {
        name: string,
        description: string,
        avatar: Avatar,
    }[]
}

type Avatar = {
    bodyShape: any,
    eyes: any,
    hair: any,
    skin: any,
    snapshots: {
        body: string,
        face: string
    },
    version: number,
    wearables: any,
}

run().then(() => console.log("Done!"))