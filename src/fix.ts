import { CatalystClient, ContentAPI } from "dcl-catalyst-client";
import { ServerAddress } from "dcl-catalyst-commons";
import { ArgumentParser } from "argparse";
import { downloadDeployment, getFailedDeployments } from "./utils/Requests";
import { FailedDeployment } from "./types";
import { executeWithProgressBar } from "./utils/Helpers";

async function run() {
  const parser = new ArgumentParser({ add_help: true, description: 'This script will go over a certain list of catalysts and try to fix all failed deployments. It will download the files from catalysts where the deployment was successful and then re-deploy it where it failed.' });
  parser.add_argument("--catalystAddresses", {
    help: "The addresses of the server we will perform the check. If not set, will check the DAO.",
    metavar: "N",
    nargs: "+",
  });
  const args = parser.parse_args();

  let serverAddresses: ServerAddress[];

  if (args.catalystAddresses) {
    serverAddresses = args.catalystAddresses;
  } else {
    serverAddresses = [
        "https://peer.decentraland.org",
        "https://peer-ec1.decentraland.org",
        "https://peer-wc1.decentraland.org",
        "https://peer-eu1.decentraland.org",
        "https://peer-ap1.decentraland.org",
        "https://interconnected.online",
        "https://peer.decentral.games",
        "https://peer.melonwave.com",
        "https://peer.kyllian.me",
        "https://peer.uadevops.com",
        "https://peer.dclnodes.io",
      ]
  }
  const servers: ContentAPI[] = serverAddresses.map(address => new CatalystClient({ catalystUrl: address }))

  try {
    await runCheck(servers);
  } catch (error) {
    console.log(error);
  }
}

async function runCheck(contentClients: ContentAPI[]) {
  // Check if there are any failed deployments
  const serverRequests = await Promise.all(
    contentClients.map<Promise<[ContentAPI, FailedDeployment[]] | undefined>>(
      async (contentClient) => {
        try {
          return [contentClient, await getFailedDeployments(contentClient.getContentUrl())];
        } catch {
          console.log(`Failed to find failed deployments for ${contentClient.getContentUrl()}. Will ignore that server.`);
          return undefined;
        }
      }
    )
  );
  const servers: [ContentAPI, FailedDeployment[]][] = serverRequests.filter(
    (_): _ is [ContentAPI, FailedDeployment[]] => !!_
  );

  // Keep only servers with failures
  const serversWithFailures: Map<ContentAPI, FailedDeployment[]> = new Map(
    servers.filter(([, failures]) => failures.length > 0)
  );

  // If there are no failures, then exit
  if (serversWithFailures.size === 0) {
    console.log(`None of the servers reported failures`);
    return;
  }

  console.log(
    `The following servers have failures:\n${Array.from(serversWithFailures.keys()).map(_ => _.getContentUrl()).join("\n")}`
  );

  let totalFixed = 0;
  let total = 0;

  for (const [server, failedDeployments] of serversWithFailures) {
    let fixedForServer = 0;

    const otherServers = contentClients.slice();
    otherServers.splice(otherServers.findIndex(otherServer => otherServer.getContentUrl() === server.getContentUrl()), 1);

    await executeWithProgressBar(
      `Fixing server ${server.getContentUrl()}`,
      failedDeployments,
      async (failure: FailedDeployment) => {
        const fixed = await fixFailure(otherServers, server, failure);
        if (fixed) {
          fixedForServer++;
        }
      },
      5
    );

    if (fixedForServer === 0) {
      console.log(`Couldn't fix any of deployments.`);
    } else if (fixedForServer === failedDeployments.length) {
      console.log(`Could fix all the ${fixedForServer} failed deployments.`);
    } else {
      console.log(
        `Could fix ${fixedForServer}/${failedDeployments.length} of failed deployments`
      );
    }

    totalFixed += fixedForServer;
    total += failedDeployments.length;
  }

  console.log(`In total, fixed ${totalFixed}/${total}`);
}

async function fixFailure(
  allServers: ContentAPI[],
  serverWithFailure: ContentAPI,
  failedDeployment: FailedDeployment
): Promise<boolean> {
  const { entityId } = failedDeployment;

  try {
    const deploymentData = await downloadDeployment(allServers, entityId);
    // Deploy the entity
    await serverWithFailure.deployEntity(deploymentData, true);
    return true;
  } catch {
    return false;
  }
}

run().then(() => console.log("Done!"));
