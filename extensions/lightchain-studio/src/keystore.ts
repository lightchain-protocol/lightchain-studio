import { randomBytes, randomUUID, scrypt, createCipheriv } from 'node:crypto';
import { keccak256, type Hex } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';

/**
 * Web3 Secret Storage v3 keystore (the format of `cast wallet import` and
 * geth), so a Lightchain Studio key can be used as `forge script --account
 * <name>` from any terminal. scrypt + AES-128-CTR, MAC = keccak256(dk[16..32] ‖ ciphertext).
 */
const N = 8192; // eth-keystore's default (what Foundry writes)
const R = 8;
const P = 1;
const DKLEN = 32;

export async function encryptKeystore(privateKey: Hex, password: string): Promise<object> {
	const salt = randomBytes(32);
	const iv = randomBytes(16);
	const dk = await new Promise<Buffer>((resolve, reject) =>
		scrypt(Buffer.from(password, 'utf8'), salt, DKLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 }, (err, key) => err ? reject(err) : resolve(key)));
	const cipher = createCipheriv('aes-128-ctr', dk.subarray(0, 16), iv);
	const ciphertext = Buffer.concat([cipher.update(Buffer.from(privateKey.slice(2), 'hex')), cipher.final()]);
	const mac = keccak256(Buffer.concat([dk.subarray(16, 32), ciphertext])).slice(2);
	return {
		crypto: {
			cipher: 'aes-128-ctr',
			cipherparams: { iv: iv.toString('hex') },
			ciphertext: ciphertext.toString('hex'),
			kdf: 'scrypt',
			kdfparams: { dklen: DKLEN, n: N, p: P, r: R, salt: salt.toString('hex') },
			mac,
		},
		id: randomUUID(),
		version: 3,
		address: privateKeyToAddress(privateKey).slice(2).toLowerCase(),
	};
}
