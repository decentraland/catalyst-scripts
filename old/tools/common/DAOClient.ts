import { ServerAddress } from "./types";
import { handlerForNetwork } from "decentraland-katalyst-contracts/utils";
import { Catalyst } from "decentraland-katalyst-contracts/Catalyst";

const NETWORK_NAME: string = "mainnet"

export class DAOClient {

    static async getAllContentServers(): Promise<ServerAddress[]> {
        const handler = handlerForNetwork(NETWORK_NAME, "catalyst");
        if (!handler) {
            throw new Error(`Can not find a network handler for Network="${NETWORK_NAME}`);
        }
        const { contract, disconnect } = handler;
        const servers: Set<ServerAddress> = await this.getAllServers(contract)
        const contentServers = Array.from(servers.values()).map(server => server + '/content')
        disconnect()
        return contentServers
    }

    private static async getAllServers(contract: Catalyst): Promise<Set<ServerAddress>> {
        const result: Set<ServerAddress> = new Set();

        const count = parseInt(await contract.methods.catalystCount().call());

        for (let i = 0; i < count; i++) {
            try {
                const katalystId = await contract.methods.catalystIds(i).call();
                let { domain } = await contract.methods.catalystById(katalystId).call();

                if (domain.startsWith("http://")) {
                    console.warn(`Catalyst node domain using http protocol, skipping ${domain}`);
                    continue;
                }

                if (!domain.startsWith("https://")) {
                    domain = "https://" + domain;
                }

                result.add(domain);
            } catch (error) { }
        }

        return result;
    }
}