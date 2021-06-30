import { ServerAddress, EntityId, EntityType } from "./common/types";
import { log, clearLogFiles } from "./common/IO";
import { deploy, downloadDeployment } from "./common/Requests";
import { getGlobalArgParser, ENTITY_TYPES } from "./common/Global";
import { DAOClient } from "./common/DAOClient";

async function run() {
    const parser = getGlobalArgParser()
    parser.addArgument('targetServer', { help: 'The address of the server where we will deploy the entity'});
    parser.addArgument('entityType', { help: 'The type of the entity', choices: ENTITY_TYPES});
    parser.addArgument('entityId', { help: 'The entity id'});
    const args = parser.parseArgs();

    clearLogFiles()
    await log("Starting deploying check")
    await runDeployment(args.targetServer, args.entityType, args.entityId)
}

async function runDeployment(targetServer: ServerAddress, entityType: EntityType, entityId: EntityId) {
    const allServers = await DAOClient.getAllContentServers()

    const deploymentData = await downloadDeployment(allServers, entityType, entityId)

    // Deploy the entity
    await log(`Deploying entity (${entityType}, ${entityId}) on ${targetServer}`)
    return deploy(targetServer, deploymentData, true)
}

run().then(() => console.log("Done!"))