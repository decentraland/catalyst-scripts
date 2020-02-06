import fs from 'fs';
import FormData from "form-data"
import fetch from "node-fetch"
import * as EthCrypto from "eth-crypto"
import * as cliProgress  from 'cli-progress';
import asyncPool from "tiny-async-pool"
import { Hashing, FileHash } from "./Hashing"
import { Authenticator } from "./Authenticator"

export const GLOBAL = { identityFilePath: "", outputDir: "" }
const LOG_PATH = () => GLOBAL.outputDir + "/log.txt"
const FAILED_PATH = () => GLOBAL.outputDir + "/failed.txt"
const CURRENT_PATH = () => GLOBAL.outputDir + "/current.txt"
const CONCURRENT_WORKERS = 15
const RETRIES = 5


let identity

function getIdentity(): { ethAddress: string, privateKey: string } {
    if (!identity) {
        identity = JSON.parse(fs.readFileSync(GLOBAL.identityFilePath).toString())
    }
    return identity as { ethAddress: string, privateKey: string }
}

export function clearLogFiles() {
    fs.writeFileSync(LOG_PATH(), Buffer.from(""))
    fs.writeFileSync(FAILED_PATH(), Buffer.from(""))
}

export async function deploy(serverAddress: string, previousId: string, deployData: DeployData): Promise<void> {
    // Calculate which hashes are not present on the content server
    const nonPresentHashes: Set<string> = await getAllHashesNotPresent(deployData, serverAddress)

    // Collect all non present files
    let filesToUpload: Set<ContentFile> = new Set()
    filesToUpload.add(deployData.entityFile)
    Array.from(deployData.otherFiles.entries())
        .filter(([hash, ]) => nonPresentHashes.has(hash))
        .map(([hash, buffer]) => ({ name: hash, content: buffer }))
        .forEach(file => filesToUpload.add(file))

    // Create form
    const form = new FormData();
    form.append('entityId'  , deployData.entityId)
    form.append('ethAddress', getIdentity().ethAddress)
    form.append('signature' , sign(deployData.entityId))
    form.append('version'   , "v2")
    form.append('migration_data', JSON.stringify(deployData.migrationData))

    let totalSize = 0
    filesToUpload.forEach(f => {
        totalSize += f.content.byteLength
        form.append(f.name, f.content, {
            filename: f.name,
        });
    })
    const totalSizeMegas = totalSize / 1024 / 1024

    // Deploy the data
    await log(`Deploying ${previousId}. Size is ${totalSizeMegas.toFixed(2)} MB. New id is ${deployData.entityId}`)
    await executeWithRetries(async () => {
        const deployResponse = await fetch(`${serverAddress}/legacy-entities`, { method: 'POST', body: form })
        if (!deployResponse.ok) {
            const text = await deployResponse.text()
            throw new Error(`Response not ok. Got ${text}`)
        }
    }, `Got an error deploying ${previousId} (new id is ${deployData.entityId})`)
}

export async function deployDefault(serverAddress: string, entityId: string, filesToUpload: Map<string, Buffer>): Promise<void> {
    // Create form
    const form = new FormData();
    form.append('entityId'  , entityId)
    form.append('ethAddress', getIdentity().ethAddress)
    form.append('signature' , sign(entityId))

    filesToUpload.forEach((content, name) => {
        form.append(name, content, {
            filename: name,
        });
    })

    // Deploy the data
    await executeWithRetries(async () => {
        const deployResponse = await fetch(`${serverAddress}/entities`, { method: 'POST', body: form })
        if (!deployResponse.ok) {
            const text = await deployResponse.text()
            throw new Error(`Response not ok. Got ${text}`)
        }
    }, `Got an error deploying default entity ${entityId}`)
}

export async function executeWithRetries<T>(executor: () => Promise<T>, errorMessage: string): Promise<T> {
    let retries = RETRIES
    while(retries > 0) {
        try {
            return await executor()
        } catch (error) {
            await log(`${errorMessage}. Retries left: ${retries - 1}. Error message:\n${error.toString()}`)
            if (retries > 1) {
                // Choose between 1 and 10 seconds to wait
                const seconds = 1 + Math.floor(Math.random() * 10);
                await sleep(seconds * 1000)
                retries--;
            } else {
                throw error
                // process.exit()
            }
        }
    }
    throw new Error(`Shouldn't get here`)
}

export async function downloadFile(url: string, previousId?: string): Promise<Buffer> {
    let error = `Got an error downloading url: '${url}'`
    if (previousId) error += ` for id '${previousId}'`
    return executeWithRetries(async () => {
        const response = await fetch(url)
        if (response.ok) {
            return response.buffer();
        } else {
            throw new Error(`Failed to fetch file on ${url}`)
        }
    }, error)
}

export async function executeWithProgressBar<T, K>(detail: string, array: Array<T>, iterator: (T) => Promise<K>): Promise<K[]> {
    const bar = new cliProgress.SingleBar({format: `${detail}: [{bar}] {percentage}% | ETA: {eta}s | {value}/{total}`});
    bar.start(array.length, 0);

    const result = await asyncPool(CONCURRENT_WORKERS, array, async (value) => {
        const result: K = await iterator(value)
        bar.increment(1)
        return result
    });

    bar.stop()

    return result
}

export async function buildEntityFile(
    entityType: string,
    pointers: string[],
    timestamp: number,
    content: { file: string, hash: FileHash}[],
    metadata: any): Promise<[FileHash, ContentFile]> {
        const entity: Entity = {
            type: entityType,
            pointers,
            timestamp,
            content,
            metadata
        }

        const file: ContentFile = entityToFile(entity)
        const entityId: FileHash = await Hashing.calculateBufferHash(file.content)
        return [entityId, file]
}

export function log(message: string) {
    return fs.promises.appendFile(LOG_PATH(), Buffer.from(message + "\n"));
}

export function failed(message: string) {
    return fs.promises.appendFile(FAILED_PATH(), Buffer.from(message + "\n"));
}

export function current(current: Set<string>) {
    const values = Array.from(current.keys()).join('\n') + '\n'
    return fs.promises.writeFile(CURRENT_PATH(), Buffer.from(values));
}

export async function fetchJson(serverAddress: string, path: string): Promise<any> {
    const url = `${serverAddress}${path}`
    return executeWithRetries(async () => {
        const response = await fetch(url)
        if (!response.ok) {
            throw new Error(`Got an error ${response.status}`)
        }
        return response.json()
    }, `Got an error fetching from ${url}`)
}

export function shuffleArray<T>(array: T[]) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

function sign(entityId: string) {
    const messageHash = Authenticator.createEthereumMessageHash(entityId)

    return EthCrypto.sign(getIdentity().privateKey, messageHash)
}

async function getAllHashesNotPresent(deployData: DeployData, serverAddress: string): Promise<Set<FileHash>> {
    const { otherFiles } = deployData
    const allHashes: FileHash[] = Array.from(otherFiles.keys())

    const result: Set<FileHash> = new Set()
    for (let i = 0 ; i < allHashes.length / 30 + 1; i++) {
        // Build query: ?cid={hashId1}&cid={hashId2}
        const query: string = "cid=" + allHashes.slice(30 * i, 30 * (i + 1)).join('&cid=')
        const response: AvailableContentResponse = await fetchJson(serverAddress, `/available-content?${query}`)
        response.filter(({ available }) => !available)
            .map(({ cid }) => cid)
            .forEach(cid => result.add(cid))
    }

    return result
}

function entityToFile(entity: Entity): ContentFile {
    return { name: "entity.json", content: Buffer.from(JSON.stringify(entity)) }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

export type ContentFile = {
    name: string,
    content: Buffer,
}

export type DeployData = {
    entityId: string,
    entityFile: ContentFile,
    otherFiles: Map<FileHash, Buffer>,
    migrationData: any
}

type Entity = {
    type: string
    pointers: string[]
    timestamp: number
    content: {file: string, hash: string}[]
    metadata: any
}

// V3
type AvailableContentResponse = {
    cid: string,
    available: boolean,
}[]