import { ServerAddress, FailedDeployment, EntityId } from "./common/types";
import { log, clearLogFiles } from "./common/IO";
import { mapAsync, executeWithProgressBar } from "./common/Helper";
import { getFailedDeployments, deploy, downloadDeployment } from "./common/Requests";
import { getGlobalArgParser } from "./common/Global";
import { DAOClient } from "./common/DAOClient";

const ENTITIES_TO_IGNORE: EntityId[] = []

async function run() {
    const parser = getGlobalArgParser()
    parser.addArgument('--serverAddresses', { help: 'The addresses of the server we will perform the check. If not set, will check the DAO.', metavar: 'N', nargs: '+'});
    const args = parser.parseArgs();

    let serverAddresses: ServerAddress[]

    if (args.serverAddresses) {
        serverAddresses = args.serverAddresses
    } else {
        serverAddresses = await DAOClient.getAllContentServers()

        // For some reason these servers are blocking our requests
        serverAddresses = serverAddresses.filter(server => server !== 'https://peer.decentral.games/content' && server !== 'https://peer.uadevops.com/content')
        serverAddresses = serverAddresses.filter(server => server !== 'https://interconnected.online/content')
    }

    clearLogFiles()
    await log("Starting fixes check")
    try {
      await runCheck(serverAddresses)
    } catch (error) {
      console.log(error)
      console.trace(error)
    }
}

async function runCheck(serverAddresses: ServerAddress[]) {
    // Check if there are any failed deployments
    const servers: [ServerAddress, FailedDeployment[]][] = await mapAsync(serverAddresses, async (server) => [server, await getFailedDeployments(server)]);

    // Keep only servers with failures
    const serversWithFailures: Map<ServerAddress, FailedDeployment[]> = new Map(servers.filter(([, failures]) => failures.length > 0))

    // If there are no failures, then exit
    if (serversWithFailures.size === 0) {
        console.log(`None of the servers reported failures`)
        return;
    }

    console.log(`The following servers have failures:\n${Array.from(serversWithFailures.keys()).join('\n')}`)

    let totalFixed = 0
    let total = 0

    for (const [server, failedDeployments] of serversWithFailures) {
        let fixedForServer = 0

        const otherServers = serverAddresses.slice()
        otherServers.splice(otherServers.indexOf(server), 1)

        await executeWithProgressBar(`Fixing server ${server}`, failedDeployments, async (failure: FailedDeployment) => {
            if (ENTITIES_TO_IGNORE.includes(failure.entityId)) {
                await log(`Ignoring ${failure.entityId} on ${server}`)
            } else {
                const fixed = await fixFailure(otherServers, server, failure)
                if (fixed) {
                    fixedForServer++
                }
            }
        }, 5)

        if (fixedForServer === 0) {
            console.log(`Couldn't fix any of deployments. Errors are on the 'failed' file.`)
        } else if (fixedForServer === failedDeployments.length) {
            console.log(`Could fix all the ${fixedForServer} failed deployments.`)
        } else {
            console.log(`Could fix ${fixedForServer}/${failedDeployments.length} of failed deployments. Errors are on the 'failed' file.`)
        }

        totalFixed += fixedForServer
        total += failedDeployments.length
    }

    console.log(`In total, fixed ${totalFixed}/${total}`)
}

async function fixFailure(allServers: ServerAddress[], serverWithFailure: ServerAddress, failedDeployment: FailedDeployment): Promise<boolean> {
    const { entityType, entityId } = failedDeployment

    try {
      const deploymentData = await downloadDeployment(allServers, entityType, entityId)
        // Deploy the entity
      await log(`Deploying entity (${entityType}, ${entityId}) on ${serverWithFailure}`)
      return deploy(serverWithFailure, deploymentData, true)
    } catch {
      return false
    }
}

run().then(() => console.log("Done!"))