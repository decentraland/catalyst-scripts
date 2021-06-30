import { CatalystClient } from "dcl-catalyst-client";
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

  if (args.serverAddresses) {
    serverAddresses = args.catalystAddresses;
  } else {
    const client = await CatalystClient.connectedToCatalystIn("mainnet", "fix script");
    const catalysts = await client.fetchCatalystsApprovedByDAO();
    serverAddresses = catalysts.map(({ address }) => address);
  }
  serverAddresses = serverAddresses.map(catalyst => `${catalyst}/content`)

  try {
    await runCheck(serverAddresses);
  } catch (error) {
    console.log(error);
  }
}

async function runCheck(serverAddresses: ServerAddress[]) {
  // Check if there are any failed deployments
  const serverRequests = await Promise.all(
    serverAddresses.map<Promise<[ServerAddress, FailedDeployment[]] | undefined>>(
      async (address) => {
        try {
          return [address, await getFailedDeployments(address)];
        } catch {
          console.log(`Failed to find failed deployments for ${address}. Will ignore that server.`);
          return undefined;
        }
      }
    )
  );
  const servers: [ServerAddress, FailedDeployment[]][] = serverRequests.filter(
    (_): _ is [ServerAddress, FailedDeployment[]] => !!_
  );

  // Keep only servers with failures
  const serversWithFailures: Map<ServerAddress, FailedDeployment[]> = new Map(
    servers.filter(([, failures]) => failures.length > 0)
  );

  // If there are no failures, then exit
  if (serversWithFailures.size === 0) {
    console.log(`None of the servers reported failures`);
    return;
  }

  console.log(
    `The following servers have failures:\n${Array.from(serversWithFailures.keys()).join("\n")}`
  );

  let totalFixed = 0;
  let total = 0;

  for (const [server, failedDeployments] of serversWithFailures) {
    let fixedForServer = 0;

    const otherServers = serverAddresses.slice();
    otherServers.splice(otherServers.indexOf(server), 1);

    await executeWithProgressBar(
      `Fixing server ${server}`,
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
      console.log(`Couldn't fix any of deployments. Errors are on the 'failed' file.`);
    } else if (fixedForServer === failedDeployments.length) {
      console.log(`Could fix all the ${fixedForServer} failed deployments.`);
    } else {
      console.log(
        `Could fix ${fixedForServer}/${failedDeployments.length} of failed deployments. Errors are on the 'failed' file.`
      );
    }

    totalFixed += fixedForServer;
    total += failedDeployments.length;
  }

  console.log(`In total, fixed ${totalFixed}/${total}`);
}

async function fixFailure(
  allServers: ServerAddress[],
  serverWithFailure: ServerAddress,
  failedDeployment: FailedDeployment
): Promise<boolean> {
  const { entityType, entityId } = failedDeployment;

  try {
    const deploymentData = await downloadDeployment(allServers, entityId);
    // Deploy the entity
    const client = new CatalystClient(serverWithFailure, "");
    await client.deployEntity(deploymentData, true);
    return true;
  } catch {
    return false;
  }
}

run().then(() => console.log("Done!"));
