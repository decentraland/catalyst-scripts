import fetch from "node-fetch"
import FormData from "form-data"
import { FileHash, ServerAddress, FailedDeployment, EntityType, EntityId, Entity, Pointer, PartialDeploymentHistory, AuditInfo, DeploymentEvent, DeploymentData } from './types';
import { executeWithRetries } from './Helper';
import { log, failed } from "./IO";

export function getFailedDeployments(serverAddress: ServerAddress): Promise<FailedDeployment[]> {
    return fetchJson(serverAddress, '/failedDeployments');
}

export function getAuditInfo(serverAddress: ServerAddress, entityType: EntityType, entityId: EntityId, retries?: number): Promise<AuditInfo> {
    return fetchJson(serverAddress, `/audit/${entityType}/${entityId}`, retries)
}

export async function getEntity(serverAddress: ServerAddress, entityType: EntityType, entityId: EntityId): Promise<Entity> {
    return (await getEntities(serverAddress, entityType, [entityId]))[0]
}

export async function getEntities(serverAddress: ServerAddress, entityType: EntityType, entityIds: EntityId[]): Promise<Entity[]> {
    const queryParams = 'id=' + entityIds.join('&id=')
    return (await fetchJson(serverAddress, `/entities/${entityType}?${queryParams}`))
        .sort((a, b) => (a.id > b.id) ? 1 : -1)
}

export function getEntityFromPointers(serverAddress: ServerAddress, entityType: EntityType, pointers: Pointer[]): Promise<Entity[]> {
    const queryParams = 'pointer=' + pointers.join('&pointer=')
    return fetchJson(serverAddress, `/entities/${entityType}?${queryParams}`)
}

export async function isContentAvailable(serverAddress: ServerAddress, fileHashes: FileHash[]): Promise<{result: Map<FileHash, boolean>, allAvailable: boolean}> {
    let error = `Got an error checking the following hashes: '${fileHashes}' from server ${serverAddress}`

    const queryParam = 'cid=' + fileHashes.join('&cid=')
    return executeWithRetries(async () => {
        const result: { cid: FileHash, available: boolean }[] = await fetchJson(serverAddress, '/available-content?' + queryParam)
        const grouped: Map<FileHash, boolean> = new Map(result.map(({ cid, available }) => [cid, available]))
        return { result: grouped, allAvailable: result.every(({ available }) => available) }
    }, error)
}

export async function getContentFile(serverAddress: ServerAddress, fileHash: FileHash, retries?: number): Promise<Buffer> {
    let error = `Got an error downloading fileHash: '${fileHash}' from server ${serverAddress}`
    return executeWithRetries(async () => {
        const response = await fetch(serverAddress + '/contents/' + fileHash)
        if (response.ok) {
            return response.buffer();
        } else {
            throw new Error(`Got status ${response.status}`)
        }
    }, error, retries)
}

export async function getSnapshot(serverAddress: ServerAddress, entityType: EntityType, retries?: number): Promise<{ snapshot: Map<EntityId, Pointer[]>, lastIncludedDeploymentTimestamp: number}> {
    let error = `Got an error fetching the snapshot for type '${entityType}' from server ${serverAddress}`
    const { hash, lastIncludedDeploymentTimestamp } = await executeWithRetries(async () => {
        const response = await fetch(serverAddress + '/snapshot/' + entityType)
        if (response.ok) {
            return response.json();
        } else {
            throw new Error(`Got status ${response.status}`)
        }
    }, error, retries)

    const file = await getContentFile(serverAddress, hash, retries)
    const snapshot: Map<EntityId, Pointer[]> = new Map(JSON.parse(file.toString()))
    return { snapshot, lastIncludedDeploymentTimestamp }
}

export async function isServerUp(serverAddress: ServerAddress) {
    try {
        await fetchJson(serverAddress, '/status')
        return true
    } catch (error) {
        return false
    }
}

export async function getAllHistory(serverAddress: string, to: number = Date.now()): Promise<DeploymentEvent[]> {
    let events: DeploymentEvent[] = []
    let offset = 0
    let keepRetrievingHistory = true
    while (keepRetrievingHistory) {
        await log(`Getting history. Offset ${offset}`)
        const partialHistory: PartialDeploymentHistory = await getPartialHistory(serverAddress, offset, to)
        events.push(...partialHistory.events)
        offset = partialHistory.pagination.offset + partialHistory.pagination.limit
        keepRetrievingHistory = partialHistory.pagination.moreData
    }
    return events
}

export async function downloadDeployment(allServers: ServerAddress[], entityType: EntityType, entityId: EntityId): Promise<DeploymentData> {
    // Download the entity file
    await log(`Fetching entity file for (${entityType}, ${entityId})`)
    const entityFile: Buffer = await tryOnMany(allServers, server => getContentFile(server, entityId, 1))

    // Get the audit info
    await log(`Fetching audit info file for (${entityType}, ${entityId})`)
    const auditInfo: AuditInfo = await tryOnMany(allServers, server => getAuditInfo(server, entityType, entityId, 1))

    // Build entity
    const entity: Entity = JSON.parse(entityFile.toString())

    // Get all content
    const content = (entity.content ?? [])

    // Download all entity's files
    const files: Map<string, Buffer> = new Map()

    for (const { hash, file } of content) {
        await log(`Fetching file with hash '${hash}'`)
        const buffer = await tryOnMany(allServers, server => getContentFile(server, hash, 1))
        files.set(file, buffer)
    }

    // Add the entity file to the list of files
    files.set("entity.json", entityFile)

    return { entityType, entityId, authChain: auditInfo.authChain, files, }
}

export async function deploy(serverAddress: ServerAddress, deploymentData: DeploymentData, fix: boolean = false): Promise<boolean> {
    const { entityType, entityId, authChain, files, } = deploymentData

    const form = new FormData();
    form.append('entityId', entityId)
    convertModelToFormData(authChain, form, 'authChain')
    files.forEach((buffer, name) => form.append(name, buffer, { filename: name }))

    try {
        const deployResponse = await fetch(`${serverAddress}/entities` + (fix ? '?fix=true' : ''), { method: 'POST', body: form })
        if (deployResponse.ok) {
            await log(`Entity (${entityType}, ${entityId}) on server ${serverAddress} fixed`)
            return true
        } else {
            await failed(`Failed to fix entity (${entityType}, ${entityId}) on server ${serverAddress}. Error was:\n${await deployResponse.text()}`)
            return false
        }
    } catch (error) {
        await failed(`Failed to fix entity (${entityType}, ${entityId}) on server ${serverAddress}. Error was:\n${error.message}`)
        return false
    }
}

function convertModelToFormData(model: any, form: FormData = new FormData(), namespace = ''): FormData {
    let formData = form || new FormData()
    for (let propertyName in model) {
        if (!model.hasOwnProperty(propertyName) || !model[propertyName]) continue
        let formKey = namespace ? `${namespace}[${propertyName}]` : propertyName
        if (model[propertyName] instanceof Date) {
            formData.append(formKey, model[propertyName].toISOString())
        } else if (model[propertyName] instanceof Array) {
            model[propertyName].forEach((element: any, index: number) => {
                const tempFormKey = `${formKey}[${index}]`
                convertModelToFormData(element, formData, tempFormKey)
            })
        } else if (typeof model[propertyName] === 'object') {
            convertModelToFormData(model[propertyName], formData, formKey)
        } else {
            formData.append(formKey, model[propertyName].toString())
        }
    }
    return formData
}

export async function tryOnMany<T>(serverAddresses: ServerAddress[], action: (server: ServerAddress) => Promise<T>): Promise<T> {
    return executeWithRetries(async () => {
        for (const serverAddress of serverAddresses) {
            try {
                return await action(serverAddress)
            } catch { }
        }
        throw new Error(`Failed to execute on all servers`)
    }, "Failed to execute action on servers", 1)
}

function getPartialHistory(serverAddress: ServerAddress, offset: number, to: number): Promise<PartialDeploymentHistory> {
    return fetchJson(serverAddress, `/history?offset=${offset}&to=${to}`)
}

export async function fetchJson(serverAddress: string, path: string, retries?: number): Promise<any> {
    const url = `${serverAddress}${path}`
    return executeWithRetries(async () => {
        const response = await fetch(url)
        if (!response.ok) {
            throw new Error(`Got an error ${response.status}`)
        }
        return response.json()
    }, `Got an error fetching from ${url}`, retries)
}