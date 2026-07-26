import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ServerIdentity {
  serverId: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

const identityDirectory = join(homedir(), ".ptys");
const privateKeyPath = join(identityDirectory, "identity.key");
const publicKeyPath = join(identityDirectory, "identity.pub");
const SERVER_ID_LENGTH = 16;

let identity: ServerIdentity | undefined;

export function getOrCreateIdentity(): ServerIdentity {
  if (identity !== undefined) {
    return identity;
  }

  mkdirSync(identityDirectory, { recursive: true, mode: 0o700 });

  let privateKey: KeyObject;
  let publicKey: KeyObject;

  if (existsSync(privateKeyPath) && existsSync(publicKeyPath)) {
    privateKey = createPrivateKey(readFileSync(privateKeyPath, "utf8"));
    publicKey = createPublicKey(readFileSync(publicKeyPath, "utf8"));
  } else {
    const generated = generateKeyPairSync("ed25519");
    privateKey = generated.privateKey;
    publicKey = generated.publicKey;
    writeFileSync(privateKeyPath, privateKey.export({ format: "pem", type: "pkcs8" }), {
      mode: 0o600,
    });
    writeFileSync(publicKeyPath, publicKey.export({ format: "pem", type: "spki" }));
  }

  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  const serverId = createHash("sha256")
    .update(publicKeyDer)
    .digest("base64url")
    .slice(0, SERVER_ID_LENGTH);

  identity = { serverId, privateKey, publicKey };
  return identity;
}
