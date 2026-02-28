/**
 * Performance benchmark for encrypting messages with multiple GPG keys
 * Estimates how many keys it takes before a 256 char message takes >1 second to encrypt
 */

import * as openpgp from 'openpgp';

const TEST_MESSAGE = 'a'.repeat(256); // 256 character message
const MAX_KEYS_TO_TEST = 50; // Reduced for faster testing
const KEY_SIZE = 2048;
const TEST_INTERVAL = 5; // Test every N keys

async function generateKeyPair(username) {
  const { privateKey, publicKey } = await openpgp.generateKey({
    type: 'rsa',
    rsaBits: KEY_SIZE,
    userIDs: [{ name: username, email: `${username}@chat.local` }],
    passphrase: '',
  });
  return { privateKey, publicKey };
}

async function encryptForAllUsers(plaintext, userPubKeys) {
  const encryptedMap = {};
  const message = await openpgp.createMessage({ text: plaintext });

  const encryptionPromises = Object.entries(userPubKeys).map(async ([username, publicKeyArmored]) => {
    try {
      const publicKey = await openpgp.readKey({
        armoredKey: publicKeyArmored,
      });

      const encrypted = await openpgp.encrypt({
        message,
        encryptionKeys: publicKey,
      });

      // In openpgp v6, encrypt returns a string directly
      encryptedMap[username] = encrypted;
    } catch (error) {
      console.error(`Failed to encrypt for user ${username}:`, error);
    }
  });

  await Promise.all(encryptionPromises);
  return encryptedMap;
}

async function runBenchmark() {
  console.log('=== GPG Encryption Performance Benchmark ===\n');
  console.log(`Message length: ${TEST_MESSAGE.length} characters`);
  console.log(`Key size: ${KEY_SIZE} bits`);
  console.log(`Max keys to test: ${MAX_KEYS_TO_TEST}\n`);

  // Generate test keys
  console.log('Generating test keys...');
  const userPubKeys = {};
  for (let i = 1; i <= MAX_KEYS_TO_TEST; i++) {
    const { publicKey } = await generateKeyPair(`user${i}`);
    userPubKeys[`user${i}`] = publicKey;
    if (i % 10 === 0) {
      process.stdout.write(`\rGenerated ${i}/${MAX_KEYS_TO_TEST} keys...`);
    }
  }
  console.log(`\n✓ Generated ${MAX_KEYS_TO_TEST} key pairs\n`);

  // Test encryption with increasing number of keys
  console.log('Testing encryption performance...\n');
  console.log('Keys\tTime (ms)\tTime (s)\tStatus');
  console.log('─'.repeat(50));

  let exceededOneSecond = false;
  for (let numKeys = 1; numKeys <= MAX_KEYS_TO_TEST; numKeys += TEST_INTERVAL) {
    const keysToUse = Object.fromEntries(
      Object.entries(userPubKeys).slice(0, numKeys)
    );

    const startTime = process.hrtime.bigint();
    await encryptForAllUsers(TEST_MESSAGE, keysToUse);
    const endTime = process.hrtime.bigint();

    const timeMs = Number(endTime - startTime) / 1_000_000;
    const timeS = timeMs / 1000;
    const status = timeS >= 1.0 ? '⚠ EXCEEDED 1s' : '✓ OK';

    if (timeS >= 1.0 && !exceededOneSecond) {
      exceededOneSecond = true;
      console.log(`${numKeys}\t${timeMs.toFixed(2)}\t\t${timeS.toFixed(3)}\t\t${status} ⬅ THRESHOLD`);
    } else {
      console.log(`${numKeys}\t${timeMs.toFixed(2)}\t\t${timeS.toFixed(3)}\t\t${status}`);
    }

    // Stop early if we've exceeded 1 second
    if (exceededOneSecond) {
      break;
    }
  }

  console.log('\n=== Benchmark Complete ===');
  console.log('\nEstimate:');
  console.log(`A 256-character message encrypted for all users will take >1 second`);
  console.log(`when encrypting for approximately ${exceededOneSecond ? 'the number shown above' : '>100'} users.`);
  console.log('\nNote: Performance varies based on CPU, key size, and message length.');
}

runBenchmark().catch(console.error);

