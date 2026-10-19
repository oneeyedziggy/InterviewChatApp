import * as openpgp from 'openpgp';

export type TestKeyPair = { privateKey: string; publicKey: string };

type TwoUserKeys = {
  alice: TestKeyPair;
  bob: TestKeyPair;
  server: TestKeyPair;
};

let fixturePromise: Promise<TwoUserKeys> | undefined;

export const twoUserCrypto = (): Promise<TwoUserKeys> => {
  fixturePromise ??= Promise.all(
    ['alice', 'bob', 'server'].map((name) =>
      openpgp.generateKey({
        type: 'rsa',
        rsaBits: 2048,
        userIDs: [{ name, email: `${name}@example.test` }],
      }),
    ),
  ).then(([alice, bob, server]) => ({ alice, bob, server }));
  return fixturePromise;
};
