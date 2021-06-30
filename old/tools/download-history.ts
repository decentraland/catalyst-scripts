import ms from "ms"
import { getGlobalArgParser } from "./common/Global";
import { ServerAddress, Timestamp } from "./common/types";
import { writeToFile } from "./common/IO";
import { getAllHistory } from "./common/Requests";
import { DAOClient } from "./common/DAOClient";
import { getServerName } from "./common/Helper";
import asyncPool from "tiny-async-pool";

async function run() {
    const parser = getGlobalArgParser()
    parser.addArgument('--serverAddresses', { help: 'The addresses of the server we will perform the check. If not set, will check the DAO.', metavar: 'N', nargs: '+'});
    parser.addArgument('outputDir', { help: 'The name of the dir where we will store the files'});
    const args = parser.parseArgs();
    console.log("Starting run check")
    let serverAddresses: ServerAddress[]

    if (args.serverAddresses) {
        serverAddresses = args.serverAddresses
    } else {
        serverAddresses = await DAOClient.getAllContentServers()
    }

    const outputDir = args.outputDir.endsWith("/") ? args.outputDir : (args.outputDir !== "" ? args.outputDir + '/' : "")

    // Date to start checking history
    const now = Date.now() - ms('5m')

    await Promise.all(serverAddresses.map(server => downloadHistoryForServer(outputDir, server, now)))
}

async function downloadHistoryForServer(outputDir: string, server: ServerAddress, to: Timestamp) {
    const fileName = getServerName(server)
    console.log(`Getting history for ${server}`)
    const serverHistory = await getAllHistory(server, to)
    console.log(`Downloaded history for ${server}`)
    const stringified = await asyncPool(50, serverHistory, async (event) => JSON.stringify(event))
    await writeToFile(fileName, stringified.join('\n'), outputDir)
    console.log(`Finished writing history for ${server}`)
}

run().then(() => console.log("Done!"))
