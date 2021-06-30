import { getGlobalArgParser } from "./common/Global";
import { EntityId, DeploymentHistory, DeploymentEvent } from "./common/types";
import { clearLogFiles, log, writeToFile , readFile, listFilesInDir} from "./common/IO";

const KNOWN_SERVERS_WITH_ERRORS = ['0b447141-540a-42dd-a579-3d95e6e83259', '47827f19-dfe7-4662-a6f8-48cdd9c078d7', '7173c4be-ac32-4662-b5f2-eff6ce28f84e', '84c62f6c-1af5-41cc-a26c-5bcf742d814b']

async function run() {
    const parser = getGlobalArgParser()
    parser.addArgument('inputDir', { help: 'The path to the dir with the file'});
    parser.addArgument('outputDir', { help: 'The path to the dir with the file'});

    const args = parser.parseArgs();

    const inputDir = args.inputDir.endsWith("/") ? args.inputDir : (args.inputDir !== "" ? args.inputDir + '/' : "")
    const outputDir = args.outputDir.endsWith("/") ? args.outputDir : (args.outputDir !== "" ? args.outputDir + '/' : "")

    clearLogFiles()
    await log("Starting comparing history")
    await runCheck(inputDir, outputDir)
}

async function runCheck(inputDir: string, outputDir: string) {
    const servers = await listFilesInDir(inputDir)

    const serversHistory = new Map(await Promise.all(servers.map<Promise<[string, DeploymentHistory]>>(async server => [server, await parseHistory(inputDir + server)])))

    const unionMap = new Map(Array.from(serversHistory.values())
        .reduce((a, b) => a.concat(b), [])
        .map(event => [event.entityId, event]))

    const union: DeploymentHistory = Array.from(unionMap.values())

    for(const [server, history] of serversHistory) {
        console.log(`Comparing ${server}`)
        const missing = missingEvents(union, history)
        await writeToFile('missing-' + server, missing.map(event => JSON.stringify(event)).join('\n'), outputDir)
    }
}

async function parseHistory(filePath: string) {
    const file = await readFile(filePath)
    return file.toString().split('\n').map(event => JSON.parse(event))
}

function missingEvents(union: DeploymentHistory, history: DeploymentHistory) {
    const organizedHistory = new Map(history.map<[EntityId, DeploymentEvent]>(event => [event.entityId, event]))

    return union.filter(event => !isEventInMap(organizedHistory, event))
        .filter(event => !KNOWN_SERVERS_WITH_ERRORS.includes(event.serverName))
}

function isEventInMap(map: Map<EntityId, DeploymentEvent>, event: DeploymentEvent) {
    const foundEvent = map.get(event.entityId)

    if (!foundEvent) {
        return false
    } else {
       return foundEvent.entityId === event.entityId &&
            foundEvent.entityType === event.entityType &&
            foundEvent.timestamp === event.timestamp &&
            foundEvent.serverName === event.serverName
    }
}

run().then(() => console.log("Done!"))
