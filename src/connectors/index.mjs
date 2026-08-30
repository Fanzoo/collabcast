import * as matrix from "./matrix.mjs";

/**
 * The connector registry. A connector is a module that knows how to deliver a
 * Collattice event to one outside system; a *target* is a named, configured
 * instance of one. Adding a connector means writing the module and adding it here
 * — see docs/writing-a-connector.md for the contract.
 */
const registry = new Map([[matrix.id, matrix]]);

export function getConnector(id) {
  return registry.get(id) ?? null;
}

export function connectorIds() {
  return [...registry.keys()].sort();
}
