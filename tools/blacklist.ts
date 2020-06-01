import { ServerAddress, Identity, Pointer, EntityType, EntityId, FileHash } from "./common/types";
import { clearLogFiles, getIdentity } from "./common/IO";
import { hash, sign } from 'eth-crypto'
import { getGlobalArgParser } from "./common/Global";

async function run() {
    const parser = getGlobalArgParser()
    parser.addArgument('serverAddress', { help: 'The address of the server where the profiles will be deployed'});
    parser.addArgument('identityFilePath', { help: 'The path to the json file where the address and private key are, to use for deployment'});
    parser.addArgument('targetType', { help: 'The type of target to blacklist'});
    parser.addArgument('targetId', { help: 'The id of target to blacklist'});
    const args = parser.parseArgs();

    clearLogFiles()
    const identity = getIdentity(args.identityFilePath)
    const target = parseDenylistTypeAndId(args.targetType, args.targetId)
    await executeBlacklisting(args.serverAddress, target, identity)
}

async function executeBlacklisting(serverAddress: ServerAddress, target: DenylistTarget, identity: Identity) {
    const timestamp = Date.now()
    const signature = hashAndSignMessage(`${target.asString()}${timestamp}`, identity)

    const body = {
        "timestamp": timestamp,
        "blocker": identity.ethAddress,
        "signature": signature
    }

    return fetch(`${serverAddress}/denylist/${target.getType()}/${target.getId()}`, { method: 'PUT', body: JSON.stringify(body), headers: {"Content-Type": "application/json"} })
}

export function hashAndSignMessage(message: string, identity: Identity) {
    const messageHash = createEthereumMessageHash(message)
    return sign(identity.privateKey, messageHash)
}

function createEthereumMessageHash(msg: string) {
    let msgWithPrefix: string = `\x19Ethereum Signed Message:\n${msg.length}${msg}`
    const msgHash = hash.keccak256(msgWithPrefix)
    return msgHash
  }

class DenylistTarget {
    private readonly id: DenylistTargetId;
    constructor(private readonly type: DenylistTargetType, id: DenylistTargetId) {
        this.id = id.toLocaleLowerCase()
    }

    asString(): string {
        return `${this.type}-${this.id}`
    }

    asObject(): { type: string, id: string } {
        return {
            type: this.type,
            id: this.id,
        }
    }

    getType() {
        return this.type
    }

    getId() {
        return this.id
    }
}

export function parseDenylistTargetString(string: string) {
    const split = string.split("-")
    const type = split.shift() as string
    const id = split.join("-")
    return parseDenylistTypeAndId(type, id)

}

export function parseDenylistTypeAndId(type: string, id: string) {
    for (const targetType of Object.values(DenylistTargetType)) {
        if (type === targetType) {
            return new DenylistTarget(DenylistTargetType[targetType.toUpperCase()], id)
        }
    }
    throw new Error(`Couldn't find a proper match for the given denylist target`);
}

enum DenylistTargetType {
    ENTITY = "entity",
    POINTER = "pointer",
    CONTENT = "content",
    ADDRESS = "address",
}
type DenylistTargetId = string

run().then(() => console.log("Done!"))