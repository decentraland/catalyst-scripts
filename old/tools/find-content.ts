import { executeWithProgressBar, createEntityChunks } from './common/Helper';
import { getEntities, getAllHistory } from './common/Requests';
import { ServerAddress, DeploymentEvent, EntityType, FileHash, Entity, EntityBase } from "./common/types";
import { clearLogFiles, log, results } from "./common/IO";
import { CHUNK_SIZE, getGlobalArgParser } from "./common/Global";

async function run() {
    const parser = getGlobalArgParser()
    parser.addArgument('serverAddress', { help: 'The address of the server we will search for the content' });
    parser.addArgument('hashes', { help: 'The hashes we want to find', metavar: 'N', nargs: '+'});
    const args = parser.parseArgs();

    clearLogFiles()
    await log(`Starting search. We are looking for ${args.hashes.length} hashes`)
    await runSearch(args.serverAddress, args.hashes)
}

async function runSearch(serverAddress: ServerAddress, hashes: FileHash[]) {
    // Get all the server's history
    console.log(`Getting server's history`)
    const history: DeploymentEvent[] = await getAllHistory(serverAddress)

    // Search through the entities
    const searchResults = await goThroughEntities(serverAddress, history, hashes)

    // Prepare result
    const result: string = Array.from(searchResults.entries())
        .map(([wantedHash, results]) => `${wantedHash}: ${results.map(({ entityType, entityId }) => `(${entityType}, ${entityId})`).join(',')}`)
        .join('\n')

    // Write to results file
    await results(result)

    // Show some on console
    if (hashes.length > 10) {
        console.log(`Please check the results file for the results :)`)
    } else {
        console.log("Results:")
        console.log(result)
    }
}

async function goThroughEntities(serverAddress: ServerAddress, history: DeploymentEvent[], hashes: FileHash[]): Promise<Map<FileHash, EntityBase[]>> {
    // Prepare the result
    const searchResults: Map<FileHash, EntityBase[]> = new Map(hashes.map(hash => [hash, []]))

    // Split the entities into chunks
    const entitiesChunks: EntityBase[][] = createEntityChunks(history);

    // Check all entities for the wanted hashes
    await executeWithProgressBar('Checking entities', entitiesChunks, async (entities: EntityBase[]) => {
        const entityType: EntityType = entities[0].entityType;
        const ids = entities.map(({ entityId }) => entityId);
        const fetchedEntities: Entity[] = await getEntities(serverAddress, entityType, ids);
        for (const fetchedEntity of fetchedEntities) {
            const contentHashes = (fetchedEntity.content ?? [])
            contentHashes
                .map(({ hash }) => hash)
                .filter(hash => hashes.includes(hash))
                .forEach(hash => searchResults.get(hash)?.push({ entityType: fetchedEntity.type, entityId: fetchedEntity.id }))
        }
    });

    await log("Finished going though the entities")

    return searchResults
}

run().then(() => console.log("Done!"))