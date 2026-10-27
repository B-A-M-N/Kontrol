// The implementation lives beside the shipped ACP adapters so the server
// source and every adapter use one identical bounded-write grant contract.
export * from "../scripts/lib/bounded-file-write.mjs";
