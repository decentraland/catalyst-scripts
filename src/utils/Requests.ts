import { assert } from "console";
import {
  CatalystClient,
  DeploymentData,
  DeploymentFields,
} from "dcl-catalyst-client";
import { ContentFile, ContentFileHash, Deployment, EntityId, fetchJson, ServerAddress } from "dcl-catalyst-commons";
import { FailedDeployment } from "../types";

export function getFailedDeployments(serverAddress: ServerAddress): Promise<FailedDeployment[]> {
  return fetchJson(`${serverAddress}/failedDeployments`);
}

export async function downloadDeployment(
  allServers: ServerAddress[],
  entityId: EntityId
): Promise<DeploymentData> {
  // Get the deployment
  const deployment: Deployment = await tryOnMany(
    allServers,
    async (server) => {
      const deployments = await server.fetchAllDeployments({
        filters: { entityIds: [entityId] },
        fields: DeploymentFields.POINTERS_CONTENT_METADATA_AND_AUDIT_INFO,
      })
      if (deployments.length == 0) { throw new Error() }// Fail if deployment was not found
      return deployments[0]
    }
  );

  // Get all files to download
  const hashes = deployment.content ? [entityId, ...deployment.content.map(({ hash }) => hash)] : [entityId]

  // Download all entity's files
  const downloadedFiles: Map<ContentFileHash, Buffer> = await downloadAllFiles(allServers, hashes)
  const files: Map<ContentFileHash, ContentFile> = new Map([...downloadedFiles].map(([hash, buffer])=> [hash, { name: hash, content: buffer }]))
  return { entityId, authChain: deployment.auditInfo.authChain, files };
}

export async function downloadAllFiles(allServers: ServerAddress[], hashes: ContentFileHash[]): Promise<Map<string, Buffer>> {
  const files: Map<string, Buffer> = new Map();
  for (const hash of hashes) {
    const buffer = await tryOnMany(allServers, (server) => server.downloadContent(hash));
    files.set(hash, buffer)
  }
  return files
}

export async function tryOnMany<T>(
  serverAddresses: ServerAddress[],
  action: (server: CatalystClient) => Promise<T>
): Promise<T> {
  for (const serverAddress of serverAddresses) {
    try {
      return await action(new CatalystClient(serverAddress, "catalyst-scripts"));
    } catch {}
  }
  throw new Error(`Failed to execute on all servers`);
}
