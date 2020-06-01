import { ArgumentParser } from "argparse"

export const ENTITY_TYPES = ["scene", "profile"]
export const GLOBAL = { outputDir: "", retries: 5, concurrency: 15 }
export const CHUNK_SIZE: number = 40

export function getGlobalArgParser(): GlobalArgumentParser {
    const parser = new GlobalArgumentParser({ addHelp: true });
    parser.addArgument(['-o', '--output'], { help: 'The path to directory where logs will be stored', defaultValue: ""});
    parser.addArgument(['--retries'], { help: 'Number of retries when an action fails', type: 'int', defaultValue: 5 });
    parser.addArgument(['--concurrency'], { help: 'Number of workers that will execute concurrently', type: 'int', defaultValue: 15 });
    return parser
}

class GlobalArgumentParser extends ArgumentParser {
    parseArgs() {
        const args = super.parseArgs()
        GLOBAL.outputDir = args.output.endsWith("/") ? args.output : (args.output !== "" ? args.output + '/' : "")
        GLOBAL.retries = args.retries
        GLOBAL.concurrency = args.concurrency
        return args
    }
}