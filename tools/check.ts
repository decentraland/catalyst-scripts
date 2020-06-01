import ms from "ms"
import { executeWithProgressBar, areObjectsTheSame, mapAsync, filterAsync, splitIntoChunks, createEntityChunks } from './common/Helper';
import { getFailedDeployments, getContentFile, getEntityFromPointers, isServerUp, getEntities, getAuditInfo, isContentAvailable, getAllHistory } from './common/Requests';
import { ServerAddress, DeploymentEvent, Pointer, EntityType, FileHash, EntityId, Entity, AuditInfo, FailedDeployment, EntityBase } from "./common/types";
import { log, clearLogFiles, results, failed } from "./common/IO";
import { getGlobalArgParser, CHUNK_SIZE, ENTITY_TYPES } from "./common/Global";
import { DAOClient } from "./common/DAOClient";

/*
 * TODO:
 * 1. Handle blacklisting when checking entities
 * 2. Get the server list from the DAO
 * 3. Add more checks when a pointer is not referencing the expected entity
 * 4. Handle the fact that there might be some failed deployments
 */

const knownOverwrittenEntities: Set<EntityId> = new Set()


const ignore =[
    "QmNn2oVpyXxNzhM8nZa4jsUu76e8EXbYDs7NaPjb8aFuxj",
    "QmbTsE4NJ1Mg82YF2xVbfkFRWkxzSJfVFgQw5eiaGNk3TH",
    "QmPJ4Ct9A3a2tVB1Cse56xxUa4MmfvLQntLeNbcvLmZgMc",
    "Qmd7fJe4qWMfzXjgqX65GPa6tDfhMuGP2npyf1brtrUPv5",
    "QmeCfwXhvXyuXcWx9eM3FCkdd5PxQ3shZtmnhWaWsAeeft",
    "QmRUp4RoTa32PLj4VC5bwfmwDc3SMBVUdsk6rzKpPLzgzf",
    "QmcvfmuW3n29pXzYNobH4FiXKBycjA79wV49JtAr8At619",
    "QmYE3oq6J59J3hEnNWYds5dn1BXa3uMFFroMTN7ZaRFVKt",
    "QmRmN36qtANL8M7x7s69ndyMe3oWKk9bViePJJNp3SKS8f",
]


async function run() {
    const parser = getGlobalArgParser()
    parser.addArgument('--serverAddresses', { help: 'The addresses of the server we will perform the check. If not set, will check the DAO.', metavar: 'N', nargs: '+'});
    parser.addArgument(['--pc'], { help: 'Percentage of content files by downloading and the comparing', type: 'int', defaultValue: 0 });

    const args = parser.parseArgs();

    let serverAddresses: ServerAddress[]

    if (args.serverAddresses) {
        serverAddresses = args.serverAddresses
    } else {
        serverAddresses = await DAOClient.getAllContentServers()
    }

    if (serverAddresses.length <= 1) {
        throw new Error(`You must set 2 or more server addresses`)
    }

    clearLogFiles()
    await log("Starting synchronization check")
    const { failedEntities, failedAudit, failedPointers, failedContent, failedContentFiles } = await runCheck(serverAddresses, args.pc)

    await log(`Failed entities: ${failedEntities.size}`)
    await log(`Failed audit infos: ${failedAudit.size}`)
    await log(`Failed pointers: ${failedPointers.size}`)
    await log(`Failed content availability: ${failedContent.size}`)
    await log(`Failed content files: ${failedContentFiles.size}`)
    await log(`\nFor more information, check the 'results' file`)

    const result =
        `Failed Entities\n` +
        Array.from(failedEntities.entries()).map(([entityId, type]) => `(${type}, ${entityId})`).join('\n') + '\n\n' +
        `Failed Audit\n` +
        Array.from(failedAudit.entries()).map(([entityId, type]) => `(${type}, ${entityId})`).join('\n') + '\n\n' +
        `Failed Pointers\n` +
        Array.from(failedPointers.entries()).map(([pointer, type]) => `(${type}, ${pointer})`).join('\n') + '\n\n' +
        `Failed Available Content\n` +
        Array.from(failedContent.values()).join('\n') + '\n\n' +
        `Failed Content Files\n` +
        Array.from(failedContentFiles.values()).join('\n');
    await results(result)
}

async function runCheck(serverAddresses: ServerAddress[], percentageContentFiles: number) {
    // Filter servers that aren't up
    const activeServers: ServerAddress[] = await filterAsync(serverAddresses, server => isServerUp(server))

    // Report down servers
    if (activeServers.length !== serverAddresses.length) {
        const downServers = serverAddresses.filter(server => !activeServers.includes(server))
        console.log(`The following servers are down: ${downServers}`)
    } else {
        console.log(`All servers are up`)
    }

    // Check if there are any failed deployments
    // const serversAndTheirFailures: [ServerAddress, Set<EntityId>][] = await mapAsync<ServerAddress, [ServerAddress, Set<EntityId>]>(activeServers, async server => [server, new Set((await getFailedDeployments(server)).map(({ deployment }) => deployment.entityId))])
    // const serversWithFailures: Map<ServerAddress, Set<EntityId>>  = new Map(serversAndTheirFailures.filter(([, failures]) => failures.size > 0))

    // // Report servers with failures
    // if (serversWithFailures.size !== 0) {
    //     console.log(`The following servers have failures: ${Array.from(serversWithFailures.keys())}`)
    // } else {
    //     console.log(`None of the servers reported failures`)
    // }

    // Date to start checking history
    const now = Date.now() - ms('2m')

    // Fetch all histories
    const allHistories: Map<ServerAddress, DeploymentEvent[]> = new Map(await mapAsync(activeServers, async server => [server, await getAllHistory(server, now)] as [ServerAddress, DeploymentEvent[]]))

    // Choose one of the histories, as reference
    const history: DeploymentEvent[] = Array.from(allHistories.values())[0]
        .filter(event => !ignore.includes(event.entityId))
    console.log(`Total length of history ${history.length}`)

    // Make sure that all history is the same
    const syncedServers: ServerAddress[] = Array.from(allHistories.entries())
        .filter(([, serverHistory]) => areHistoriesTheSame(history, serverHistory.filter(event => !ignore.includes(event.entityId))))
        .map(([server, ]) => server)

    // Report servers out of sync
    if (syncedServers.length !== allHistories.size) {
        const serversOutOfSync = Array.from(allHistories.keys()).filter(server => !syncedServers.includes(server))
        console.log(`The following servers don't have the same history as the base: ${serversOutOfSync}`)
    } else {
        console.log(`All servers reported the same history`)
    }

    if (syncedServers.length < 2) {
        console.log(`Need 2 or more servers with the same history to continue checks`)
        process.exit(1)
    }

    // Check entities
    const { referencedPointers, referencedContent, failedEntities } = await checkEntities(history, syncedServers);

    // Check pointers
    const failedPointers: Map<Pointer, EntityType> = await checkPointers(referencedPointers, syncedServers);

    // Check audit info
    const failedAudit = await checkAuditInfo(history, syncedServers);

    // Check content existence
    const { failedContent, availableContentInAllServers } = await checkContentExistence(referencedContent, syncedServers);

    // Check content files
    const failedContentFiles = await checkContentFiles(availableContentInAllServers,referencedContent, percentageContentFiles, syncedServers);

    return { failedContent, failedPointers, failedContentFiles, failedEntities, failedAudit }
}

async function checkEntities(history: DeploymentEvent[], syncedServers: ServerAddress[]) {
    const referenceServer = syncedServers[0]
    const referencedPointers: Map<EntityType, Map<Pointer, EntityId>> = new Map(ENTITY_TYPES.map(type => [type, new Map()]))
    const referencedContent: Map<FileHash, { entityType: EntityType, entityId: EntityId }[]> = new Map()
    const failedEntities: Map<EntityId, EntityType> = new Map()

    const entitiesChunks: EntityBase[][] = createEntityChunks(history);

    // Check entities
    await executeWithProgressBar('Checking entities', entitiesChunks, async (entities: { entityType: EntityType; entityId: EntityId; }[]) => {
        const entityType: EntityType = entities[0].entityType;
        const ids = entities.map(({ entityId }) => entityId);
        const referenceEntities: Entity[] = await getEntities(referenceServer, entityType, ids);
        if (referenceEntities.length !== entities.length) {
            await failed(`Expected to find ${entities.length} entities when searching for ids ${ids} on server ${referenceServer}. Instead found ${referenceEntities.length}`);
        } else {
            for (let i = 1; i < syncedServers.length; i++) {
                const entities = await getEntities(syncedServers[i], entityType, ids);
                if (!areObjectsTheSame(referenceEntities, entities)) {
                    entities.forEach(entity => failedEntities.set(entity.id, entity.type));
                    await failed(`Found a mismatch. Entities with ids ${ids} are different in ${referenceServer} and ${syncedServers[i]}`);
                    process.exit();
                }
            }
            for (const entity of referenceEntities) {
                referencedContent.set(entity.id, [{ entityId: entity.id, entityType: entityType }])

                // If none of the pointers are on the set, then it means that they are active (since we are going from newest entity to oldest)
                if (!arePointersInMap(entity.pointers, referencedPointers.get(entityType)!!)) {
                    entity.pointers.forEach(pointer => referencedPointers.get(entityType)!!.set(pointer, entity.id));

                    for (const hash of (entity.content ?? []).map(({ hash }) => hash)) {
                        if (referencedContent.has(hash)) {
                            referencedContent.get(hash)!!.push({ entityId: entity.id, entityType: entityType });
                        } else {
                            referencedContent.set(hash, [{ entityId: entity.id, entityType: entityType }]);
                        }
                    }
                } else {
                    knownOverwrittenEntities.add(entity.id)
                }
            }
        }
    });

    return { referencedPointers, referencedContent, failedEntities }
}

async function checkPointers(referencedPointers: Map<string, Map<string, string>>, syncedServers: string[]) {
    const failedPointers: Map<Pointer, EntityType> = new Map()
    let overwrittenPointers = 0

    const pointerChunks: { pointer: Pointer; entityId: EntityId; entityType: EntityType; }[][] = createPointerChunks(referencedPointers);
    await executeWithProgressBar('Checking pointers', pointerChunks, async (pointerData) => {
        const { entityType } = pointerData[0];
        const pointers = pointerData.map(({ pointer }) => pointer);
        for (let i = 0; i < syncedServers.length; i++) {
            try {
                const entities = await getEntityFromPointers(syncedServers[i], entityType, pointers);
                const entitiesByPointer: Map<Pointer, EntityId> = new Map();
                entities.forEach(entity => entity.pointers.forEach(pointer => entitiesByPointer.set(pointer, entity.id)));
                for (const { entityType, entityId, pointer } of pointerData) {
                    if (entitiesByPointer.get(pointer) !== entityId) {
                        const auditInfo = await getAuditInfo(syncedServers[i], entityType, entityId);
                        if (!auditInfo.overwrittenBy) {
                            failedPointers.set(pointer, entityType);
                            await failed(`Found a mismatch. Entity in pointer ${pointer} was expected to be ${entityId}, but it is ${entitiesByPointer.get(pointer)} on ${syncedServers[i]}`);
                        } else {
                            overwrittenPointers++
                        }
                    }
                }
            } catch (error) {
                pointers.forEach(pointer => failedPointers.set(pointer, entityType));
                await failed(error);
            }
        }
    });

    await log(`Checked pointers. ${overwrittenPointers} were overwritten`)

    return failedPointers
}

async function checkContentFiles(availableContentInAllServers: FileHash[], referencedContent: Map<FileHash, { entityType: EntityType, entityId: EntityId }[]>, percentageContentFiles: number, syncedServers: string[]) {
    const failedContentFiles: Set<FileHash> = new Set()
    const referenceServer = syncedServers[0]

    const randomContent: FileHash[] = []
    // const randomContent: FileHash[] = chooseRandom(availableContentInAllServers, percentageContentFiles, 'content hashes that are present on all servers');

    await executeWithProgressBar('Checking content values', randomContent, async ({ fileHash }) => {
        const referenceContent = await getContentFile(referenceServer, fileHash);
        for (let i = 1; i < syncedServers.length; i++) {
            try {
                const content = await getContentFile(syncedServers[i], fileHash);
                if (referenceContent.compare(content) !== 0) {
                    failedContentFiles.add(fileHash);
                    await failed(`Found a mismatch. Content from file ${fileHash} is different in ${referenceServer} and ${syncedServers[i]}`);
                }
            } catch (err) {
                failedContentFiles.add(fileHash);
                await failed(`Failed to fetch content with hash ${fileHash} from server ${syncedServers[i]}`);
            }
        }
    });

    return failedContentFiles
}

async function checkContentExistence(referencedContent: Map<FileHash, { entityType: EntityType, entityId: EntityId }[]>, syncedServers: string[]) {
    const failedContent: Set<FileHash> = new Set()
    const nonAvailable: Set<FileHash> = new Set()

    // Keep hashes that are entity ids, or that the entity where they belong was not overwritten
    const nonOverwrittenHashes = Array.from(referencedContent.entries())
        .filter(([fileHash, entities]) => fileHash === entities[0].entityId || !isAnyOfTheEntitiesOverwritten(entities))
        .map(([fileHash]) => fileHash)

    // Check content existence
    await executeWithProgressBar('Checking content existence', splitIntoChunks(nonOverwrittenHashes, CHUNK_SIZE), async (hashes: FileHash[]) => {
        for (let i = 0; i < syncedServers.length; i++) {
            try {
                const { result, allAvailable } = await isContentAvailable(syncedServers[i], hashes);
                if (!allAvailable) {
                    Array.from(result.entries())
                        .filter(([available]) => available)
                        .map(([hash]) => hash)
                        .forEach(hash => nonAvailable.add(hash))
                }
            } catch (err) {
                hashes.forEach(hash => failedContent.add(hash));
                await failed(`Failed to check availability of content with hashes ${hashes}.`);
            }
        }
    });

    await log(`Checked available hashes. ${referencedContent.size - nonOverwrittenHashes.length} were not present due to overwrite`)

    if (nonAvailable.size > 0) {
        for (const hash of nonAvailable) {
            failedContent.add(hash)
            await failed(`The following hash was not available, when it should have ${hash}.`);
        };
    }

    const availableContentInAllServers = Array.from(referencedContent.keys()).filter(hash => !nonAvailable.has(hash))

    return { failedContent, availableContentInAllServers }
}

async function checkAuditInfo(history: DeploymentEvent[], syncedServers: ServerAddress[]) {
    const referenceServer = syncedServers[0]
    const failedAudit: Map<EntityId, EntityType> = new Map()

    await executeWithProgressBar('Checking audit info', history, async ({ entityType, entityId }) => {
        const auditInfos: Map<ServerAddress, AuditInfo> = new Map(await Promise.all(syncedServers.map<Promise<[ServerAddress, AuditInfo]>>(async server => [server, await getAuditInfo(server, entityType, entityId)])))
        const referenceAuditInfo: AuditInfo = auditInfos.get(referenceServer)!!;
        if (referenceAuditInfo.overwrittenBy) {
            knownOverwrittenEntities.add(entityId)
        }
        for (let i = 1; i < syncedServers.length; i++) {
            try {
                const auditInfo = auditInfos.get(syncedServers[i])!!
                if (!auditAreTheSame(referenceServer, syncedServers[i], entityType, referenceAuditInfo, auditInfo)) {
                    failedAudit.set(entityId, entityType);
                    await failed(`Found a mismatch. Audit info for (${entityType}, ${entityId}) is different in ${referenceServer} and ${syncedServers[i]}`);
                }
                if (auditInfo.overwrittenBy) {
                    knownOverwrittenEntities.add(entityId)
                }
            } catch (err) {
                failedAudit.set(entityId, entityType);
                await failed(`Failed to fetch audit info (${entityType}, ${entityId}) on server ${syncedServers[i]}`);
            }
        }
    });

    return failedAudit
}

function arePointersInMap(pointers: Pointer[], map: Map<Pointer, EntityId>): boolean {
    for (const pointer of pointers) {
        if (map.has(pointer)) {
            return true
        }
    }
    return false
}

function createPointerChunks(referencedPointers: Map<EntityType, Map<Pointer, EntityId>>) {
    let pointerChunks: { entityType: EntityType; pointer: Pointer, entityId: EntityId }[][] = [];
    for (const [entityType, pointers] of referencedPointers.entries()) {
        const entities = Array.from(pointers.entries())
            .map(([pointer, entityId]) => ({ pointer, entityId, entityType }));
            pointerChunks = pointerChunks.concat(splitIntoChunks(entities, CHUNK_SIZE));
    }

    return pointerChunks;
}

async function auditAreTheSame(server1: ServerAddress, server2: ServerAddress, entityType: EntityType, auditInfo1: AuditInfo, auditInfo2: AuditInfo): Promise<boolean> {
    const immutablePropertiesAreTheSame: boolean =
        auditInfo1.version === auditInfo2.version &&
        auditInfo1.deployedTimestamp === auditInfo2.deployedTimestamp &&
        auditInfo1.authChain === auditInfo2.authChain &&
        auditInfo1.originalMetadata === auditInfo2.originalMetadata;

        if (!immutablePropertiesAreTheSame) {
        return false
    }

    if (auditInfo1.overwrittenBy !== auditInfo2.overwrittenBy) {
        if (auditInfo1.overwrittenBy && auditInfo2.overwrittenBy) {
            return false
        } else if (auditInfo1.overwrittenBy) {
            const overwritingAuditInfo: AuditInfo = await getAuditInfo(server1, entityType, auditInfo1.overwrittenBy)
            return overwritingAuditInfo.deployedTimestamp > auditInfo1.deployedTimestamp
        } else if (auditInfo2.overwrittenBy) {
            const overwritingAuditInfo: AuditInfo = await getAuditInfo(server2, entityType, auditInfo2.overwrittenBy)
            return overwritingAuditInfo.deployedTimestamp > auditInfo2.deployedTimestamp
        }
    }

    return true
}

function isAnyOfTheEntitiesOverwritten(entities: { entityType: EntityType, entityId: EntityId }[]) {
    for (const { entityId } of entities) {
        if (knownOverwrittenEntities.has(entityId)) {
            return true
        }
    }
    return false
}

run().then(() => console.log("Done!"))


function areHistoriesTheSame(history1: DeploymentEvent[], history2: DeploymentEvent[]): boolean {
    if (history1.length !== history2.length) {
        return false
    }
    for (let i = 0; i < history1.length; i++) {
        const { serverName: serverName1, entityType: entityType1, entityId: entityId1, timestamp: timestamp1} = history1[i]
        const { serverName: serverName2, entityType: entityType2, entityId: entityId2, timestamp: timestamp2} = history2[i]
        if (entityType1 !== entityType2 ||
            entityId1 !== entityId2 ||
            timestamp1 !== timestamp2) {
                console.log("FOUND")
                console.log(history1[i])
                console.log("EXPECTED")
                console.log(history2[i])
                return false
        }
    }
    return true
}

