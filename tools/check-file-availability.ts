import { ContentClient, DeploymentFields } from "dcl-catalyst-client"
import { executeWithProgressBar, filterAsync, splitIntoChunks } from './common/Helper';
import { isServerUp, isContentAvailable } from './common/Requests';
import { ServerAddress, FileHash, EntityId, Timestamp } from "./common/types";
import { log, clearLogFiles, failed } from "./common/IO";
import { getGlobalArgParser, CHUNK_SIZE } from "./common/Global";
import { DAOClient } from "./common/DAOClient";


async function run() {
    const parser = getGlobalArgParser()
    parser.addArgument('--serverAddresses', { help: 'The addresses of the server we will perform the check. If not set, will check the DAO.', metavar: 'N', nargs: '+'});

    const args = parser.parseArgs();

    let serverAddresses: ServerAddress[]

    if (args.serverAddresses) {
        serverAddresses = args.serverAddresses
    } else {
        serverAddresses = await DAOClient.getAllContentServers()
    }


    clearLogFiles()
    await log("Starting content check")
    await runCheck(serverAddresses)
}

type Info = { entityId: EntityId, entityTimestamp: Timestamp, localTimestamp: Timestamp, originTimestamp: Timestamp, overwrittenBy?: EntityId }

async function runCheck(serverAddresses: ServerAddress[]) {
    // Check active servers
    const activeServers: ServerAddress[] = await filterAsync(serverAddresses, server => isServerUp(server))

    for (const server of activeServers) {
        // Store to collect all hashes that should be available
        const activeHashes: Map<FileHash, Set<Info>> = new Map()

        // Collect all hashes
        const client = new ContentClient(server, 'test')
        const deployments = await client.fetchAllDeployments({ filters: { onlyCurrentlyPointed: true }, fields: DeploymentFields.POINTERS_CONTENT_METADATA_AND_AUDIT_INFO })
        deployments.forEach(deployment => {
            if (deployment.content) {
                deployment.content.forEach(({ hash }) => {
                    if (!activeHashes.has(hash)) {
                        activeHashes.set(hash, new Set())
                    }
                    const info = {
                        entityId: deployment.entityId,
                        entityTimestamp: deployment.entityTimestamp,
                        localTimestamp: deployment.auditInfo.localTimestamp,
                        originTimestamp: deployment.auditInfo.originTimestamp,
                        overwrittenBy: deployment.auditInfo.overwrittenBy
                    }
                    activeHashes.get(hash)!!.add(info)
                })
            }
        })

        await checkContentExistence(activeHashes, server)
    }
}

async function checkContentExistence(activeHashes: Map<FileHash, Set<Info>>, server: ServerAddress) {
    const nonAvailable: Map<FileHash, Set<Info>> = new Map()

    // Check content existence
    await executeWithProgressBar('Checking content existence', splitIntoChunks(Array.from(activeHashes.keys()), CHUNK_SIZE), async (hashes: FileHash[]) => {
        const { result, allAvailable } = await isContentAvailable(server, hashes);
        if (!allAvailable) {
            Array.from(result.entries())
                .filter(([, available]) => !available)
                .map(([hash]) => hash)
                .forEach(hash => nonAvailable.set(hash, activeHashes.get(hash)!!))
        }
    });

    if (nonAvailable.size > 0) {
        await failed('------------------------------------------------------------------------')
        await failed(`Errors for server ${server}`)

        for (const [hash, entities] of nonAvailable) {
            await failed(`Hash: ${hash}. Entities: ${JSON.stringify(Array.from(entities.values()))}`);
        };
        await failed('')
    } else {
        await log(`Server ${server} had no issues`)
    }
}

run().then(() => console.log("Done!"))


