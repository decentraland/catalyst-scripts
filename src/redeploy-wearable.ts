import { CatalystClient, ContentClient } from "dcl-catalyst-client";
import { ContentFileHash, EntityType, Hashing } from "dcl-catalyst-commons";
import { ArgumentParser } from "argparse";
import EthCrypto from "eth-crypto";
import { Authenticator } from "dcl-crypto";
import fs from "fs";

async function run() {
  const parser = new ArgumentParser({
    add_help: true,
    description:
      "This script will take a wearable and try to re-deploy it with a new timestamp.",
  });
  parser.add_argument("target", {
    help: "The address of the catalyst we will use to download and re-deploy the wearable.",
  });
  parser.add_argument("wearable", {
    help: "The id of the wearable we want to re-deploy",
  });
  parser.add_argument("path", {
    help: "The path to the file were the deployer's key is. It needs to be a committee member",
  });
  parser.add_argument('--dryRun', { action: 'store_true', default: false, help: 'If set, there will be no deployment and only the hash will be calculated' })
  const args = parser.parse_args();

  const klass = args.target.includes('localhost') ? ContentClient : CatalystClient
  const client = new klass(args.target, "catalyst-scripts");
  const entities = await client.fetchEntitiesByIds(EntityType.WEARABLE, [args.wearable]);
  if (entities.length === 0) {
    console.log("Failed to find a wearable with the given id");
    process.exit(1);
  }

  const entity = entities[0];

  if (args.dryRun) {
    const contentAsJson = entity.content?.map(({file, hash}) => ({ key: file, hash })).sort(( a, b ) => a.hash > b.hash ? 1 : -1) ?? []
    const buffer = Buffer.from(JSON.stringify({ content: contentAsJson, metadata: entity.metadata }))
    console.log(contentAsJson)
    console.log(entity.metadata)
    const hash = await Hashing.calculateBufferHash(buffer)
    console.log(`Hash is ${hash}`)
  } else {
    const hashesByKey: Map<string, ContentFileHash> = new Map(entity.content?.map(({ file, hash }) => [file, hash]))
    const { entityId, files } = await client.buildEntityWithoutNewFiles({
      ...entity,
      hashesByKey,
      timestamp: Date.now() - 30 * 1000
    });

    const buffer = fs.readFileSync(args.path)
    const { privateKey, address } = JSON.parse(buffer.toString())
    const messageHash = Authenticator.createEthereumMessageHash(entityId);
    const signature = EthCrypto.sign(privateKey, messageHash);

    const authChain = Authenticator.createSimpleAuthChain(
      entityId,
      address,
      signature
    );
    console.log(`Deploying entity with id ${entityId}`)
    await client.deployEntity({ entityId, files, authChain });
  }
}


run().then(() => console.log("Done!"));
