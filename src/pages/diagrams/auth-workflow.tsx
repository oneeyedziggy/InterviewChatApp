'use client';

import Head from 'next/head';
import Link from 'next/link';
import MermaidDiagram from '../../components/MermaidDiagram';
import styles from '../../styles/Diagrams.module.css';

const AUTH_CHART = `flowchart TD
  classDef client fill:#eef6ff,stroke:#004ca8,color:#0c1b33
  classDef server fill:#e6fbff,stroke:#006f84,color:#0c1b33
  classDef store fill:#fff4e0,stroke:#a8630a,color:#2a1c00

  subgraph BOOT["1 - Bootstrap"]
    B1["CLIENT<br/>GET /api/server-status<br/>learns requiresInvite"]:::client
    B2["CLIENT<br/>GET /api/server-public-key<br/>armored RSA-2048 tenant public key"]:::client
    B1 --> B2
  end

  B2 --> R0{"Existing local account?"}

  subgraph REG["2 - Registration - new account"]
    R1["CLIENT<br/>openpgp.js v6 generateKey<br/>RSA-2048, uid name plus username@chat.local, empty passphrase"]:::client
    R2["CLIENT<br/>scrypt KDF over password<br/>N=32768, r=8, p=1, dkLen=32, 16-byte random salt"]:::client
    R3["CLIENT<br/>AES-256-GCM encrypt private key<br/>12-byte random IV, tag appended"]:::client
    R4["LOCAL STORAGE<br/>enc-v1 envelope JSON in gpg_user_USERNAME_privateKey<br/>public key, userId, gpg_all_users"]:::store
    R5["CLIENT<br/>usernameHash = SHA-256 of username<br/>usernameCiphertext = OpenPGP encrypt to server key"]:::client
    R6["POST /api/login<br/>userId, publicKey, usernameHash, usernameCiphertext, inviteCode"]:::client
    R7["SERVER<br/>SHA-256 hash of invite code<br/>ConsumeInvite: active, unexpired 24h, single use"]:::server
    R8["SERVER<br/>persist users row: public_key, username_ciphertext,<br/>invited_by_user_id, joined_at"]:::server
    R1 --> R2 --> R3 --> R4 --> R5 --> R6 --> R7 --> R8
  end

  subgraph LOGIN["3 - Challenge-response login - existing account"]
    L1["CLIENT<br/>POST /api/login with userId plus publicKey"]:::client
    L2["SERVER<br/>challenge = UUIDv4<br/>OpenPGP encrypt to user public key<br/>cache challenge_userId, 4h TTL"]:::server
    L3["CLIENT<br/>unlock private key:<br/>in-memory cache, service worker broker, else scrypt plus AES-256-GCM with password"]:::client
    L4["CLIENT<br/>OpenPGP decrypt challenge with private key<br/>re-encrypt same UUID to server public key"]:::client
    L5["CLIENT<br/>POST /api/login with userId plus encryptedUUID"]:::client
    L6["SERVER<br/>decrypt with tenant private key<br/>constant compare with cached challenge, then delete it"]:::server
    L1 --> L2 --> L3 --> L4 --> L5 --> L6
  end

  R0 -- "no" --> R1
  R0 -- "yes" --> L1

  R8 --> S1
  L6 --> S1

  subgraph SESSION["4 - Session issuance"]
    S1["SERVER<br/>sessionId = 16 random bytes hex encoded<br/>sessionCache sessionId to userId, 4h TTL"]:::server
    S2["CLIENT<br/>store sessionId in per-server map<br/>OpenPGP encrypted to own public key"]:::client
    S3["LOCAL STORAGE<br/>gpg_user_USERNAME_encryptedServerSessions<br/>serverId to sessionId, plus legacy gpg_session_id"]:::store
    S4["CLIENT<br/>POST /api/auth on reload to revalidate sessionId"]:::client
    S1 --> S2 --> S3 --> S4
  end

  S3 --> W1

  subgraph SOCKET["5 - Signed socket mutations"]
    W1["CLIENT<br/>connect WSS /ws/?server=SERVER_ID"]:::client
    W2["CLIENT<br/>nonce = crypto.randomUUID or 16 random bytes<br/>signing input: v1 pipe event pipe userId pipe sessionId pipe timestamp pipe nonce pipe sorted base64url claims"]:::client
    W3["CLIENT<br/>OpenPGP detached signature with private key"]:::client
    W4["SERVER<br/>VerifyDetached with stored user public key"]:::server
    W5["SERVER<br/>session owns userId, timestamp within plus or minus 5 min,<br/>claims equal payload, nonce not replayed"]:::server
    W6["SERVER<br/>apply mutation and broadcast ciphertext only"]:::server
    W1 --> W2 --> W3 --> W4 --> W5 --> W6
  end

  subgraph CAP["6 - Creating a new server tenant"]
    C1["CLIENT<br/>POST /api/server-creation-capability with publicKey"]:::client
    C2["SERVER<br/>capability = 32 random bytes base64url<br/>stores SHA-256 hash bound to that public key, 10 min TTL"]:::server
    C3["CLIENT<br/>detached signature over server-create:v1:CAPABILITY"]:::client
    C4["POST /api/servers<br/>capability, publicKey, signature, userId, usernameHash, usernameCiphertext"]:::client
    C5["SERVER<br/>verify signature against bound key, check TTL,<br/>consume capability single use"]:::server
    C6["SERVER<br/>provision tenant: own SQLite file, own RSA-2048 server key,<br/>opaque serverId plus diceware alias, first session issued"]:::server
    C1 --> C2 --> C3 --> C4 --> C5 --> C6
  end

  B2 --> C1
  C6 --> S1`;

const AuthWorkflowPage = () => (
  <>
    <Head>
      <title>Authentication Workflow Diagram</title>
    </Head>
    <main className={styles.page}>
      <section className={styles.header}>
        <p className={styles.kicker}>Architecture</p>
        <h1 className={styles.title}>Authentication workflow</h1>
        <p className={styles.subtitle}>
          Accounts are OpenPGP keypairs generated in the browser. The server
          never receives a password, a private key, or a plaintext username: it
          only stores public keys, ciphertext, and opaque identifiers.
        </p>
        <Link href="/diagrams" className={styles.backLink}>
          Back to all diagrams
        </Link>
      </section>

      <section className={styles.shell} aria-label="Authentication workflow">
        <div className={styles.diagramCard}>
          <MermaidDiagram chart={AUTH_CHART} title="Authentication workflow" />
        </div>

        <div className={styles.notesCard}>
          <h2>Algorithms and lifetimes</h2>
          <ul>
            <li>
              Identity keypair: OpenPGP <code>RSA-2048</code>, one global
              keypair per account reused across every server. Persistent.
            </li>
            <li>
              Private key at rest: <code>scrypt</code> (N=32768, r=8, p=1,
              dkLen=32, 16-byte salt) then <code>AES-256-GCM</code> with a
              12-byte IV, serialized as the <code>enc-v1</code> envelope in
              localStorage. Persistent.
            </li>
            <li>
              Unlocked private key: held in memory and in the
              <code>/private-key-broker-sw.js</code> service worker only.
              Ephemeral.
            </li>
            <li>
              Login challenge: <code>UUIDv4</code> encrypted to the user public
              key, answered by re-encrypting to the server public key. One-time,
              deleted on success.
            </li>
            <li>
              Session token: 16 random bytes hex encoded, 4 hour TTL server
              side, stored client side in an OpenPGP-encrypted per-server map.
            </li>
            <li>
              Invite code: 32 random bytes base64url, stored server side only as
              a <code>SHA-256</code> hash, single use, 24 hour TTL, revocable.
            </li>
            <li>
              Server creation capability: 32 random bytes, hash stored, bound to
              the requesting public key, 10 minute TTL, single use, redeemed
              with a detached signature over{' '}
              <code>server-create:v1:CAPABILITY</code>.
            </li>
            <li>
              Socket mutations: OpenPGP detached signature over a canonical
              claim string, verified with a 5 minute clock skew tolerance and
              nonce replay rejection.
            </li>
          </ul>
        </div>
      </section>
    </main>
  </>
);

export default AuthWorkflowPage;
