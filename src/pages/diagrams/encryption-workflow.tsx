'use client';

import Head from 'next/head';
import Link from 'next/link';
import MermaidDiagram from '../../components/MermaidDiagram';
import styles from '../../styles/Diagrams.module.css';

const ENCRYPTION_CHART = `flowchart TD
  classDef client fill:#eef6ff,stroke:#004ca8,color:#0c1b33
  classDef server fill:#e6fbff,stroke:#006f84,color:#0c1b33
  classDef store fill:#fff4e0,stroke:#a8630a,color:#2a1c00
  classDef ephemeral fill:#f3e9ff,stroke:#6a2fb5,color:#20073d

  subgraph SEND["1 - Sending - encryptForAllUsers"]
    E1["CLIENT<br/>plaintext message body"]:::client
    E2["CLIENT<br/>recipient set = room members plus sender<br/>public keys from local directory cache"]:::client
    E3["EPHEMERAL<br/>content key = crypto.getRandomValues 32 bytes<br/>one-time per message, never persisted"]:::ephemeral
    E4["EPHEMERAL<br/>IV = crypto.getRandomValues 12 bytes, one-time"]:::ephemeral
    E5["CLIENT<br/>AES-256-GCM encrypt body with content key and IV<br/>WebCrypto subtle.encrypt, auth tag included"]:::client
    E6["CLIENT<br/>per recipient: base64 of content key<br/>OpenPGP encrypt to that recipient RSA-2048 public key"]:::client
    E7["CLIENT<br/>envelope JSON<br/>version msg-v2, iv, ciphertext, keyEnvelopes userId to armored PGP"]:::client
    E1 --> E3
    E2 --> E6
    E3 --> E5
    E4 --> E5
    E3 --> E6
    E5 --> E7
    E6 --> E7
  end

  E7 --> T1

  subgraph TRANSPORT["2 - Transport"]
    T1["CLIENT<br/>clientMessage over WebSocket<br/>wrapped in v1 detached-signature mutation envelope"]:::client
    T2["SERVER<br/>verify detached signature, session, plus or minus 5 min skew, nonce"]:::server
    T1 --> T2
  end

  T2 --> P1

  subgraph PERSIST["3 - Server storage - blind"]
    P1["SQLITE messages<br/>encrypted_message = AES-GCM ciphertext envelope<br/>encrypted_for_json = wrapped content key per userId"]:::store
    P2["SQLITE rooms<br/>room_name_hash = SHA-256 of name<br/>room_name_ciphertext = OpenPGP encrypted name"]:::store
    P3["SQLITE users<br/>username_ciphertext = OpenPGP encrypted username<br/>public_key, joined_at"]:::store
    P4["SERVER holds no content key, no private key,<br/>no plaintext body, name, or username"]:::server
    P1 --> P4
    P2 --> P4
    P3 --> P4
  end

  P1 --> D0

  subgraph RECEIVE["4 - Receiving - decryptMessageForUser"]
    D0{"parseMessageEnvelope<br/>version equals msg-v2?"}
    D1["CLIENT<br/>try each entry in keyEnvelopes with unlocked private key<br/>until one decrypts"]:::client
    D2["CLIENT<br/>base64 decode recovered 32-byte content key"]:::client
    D3["CLIENT<br/>AES-256-GCM decrypt ciphertext with envelope IV<br/>render plaintext"]:::client
    D4["CLIENT LEGACY<br/>direct OpenPGP decrypt of the armored message"]:::client
    D5["Not encrypted for this user<br/>queue opaque access grant request"]:::client
    D0 -- "yes" --> D1
    D0 -- "no - legacy or unparsable" --> D4
    D1 -- "match found" --> D2 --> D3
    D1 -- "no match" --> D5
    D4 --> D3
  end

  subgraph SHARE["5 - Re-sharing and account transfer"]
    G1["CLIENT<br/>new member or approved grant:<br/>re-wrap cached content keys for the new public key"]:::client
    G2["CLIENT<br/>account transfer package JSON<br/>private key envelope, public key, memberships, directory, blocks"]:::client
    G3["CLIENT<br/>AES password re-verification before export<br/>no active session tokens included"]:::client
    G4["CLIENT<br/>OpenPGP encrypt package to recipient public key<br/>stored as key_transfer_encrypted_package"]:::client
    G1 --> P1
    G2 --> G3 --> G4 --> P1
  end`;

const EncryptionWorkflowPage = () => (
  <>
    <Head>
      <title>Message Encryption Workflow Diagram</title>
    </Head>
    <main className={styles.page}>
      <section className={styles.header}>
        <p className={styles.kicker}>Architecture</p>
        <h1 className={styles.title}>Message encryption workflow</h1>
        <p className={styles.subtitle}>
          The <code>msg-v2</code> envelope encrypts each message body once with
          a random symmetric content key and then wraps only that small key for
          every recipient, instead of re-encrypting the whole body per recipient
          with RSA.
        </p>
        <Link href="/diagrams" className={styles.backLink}>
          Back to all diagrams
        </Link>
      </section>

      <section
        className={styles.shell}
        aria-label="Message encryption workflow"
      >
        <div className={styles.diagramCard}>
          <MermaidDiagram
            chart={ENCRYPTION_CHART}
            title="Message encryption workflow"
          />
        </div>

        <div className={styles.notesCard}>
          <h2>Keys, order, and persistence</h2>
          <ul>
            <li>
              Order per message: generate content key, generate IV, AES-256-GCM
              encrypt body, OpenPGP wrap the key once per recipient, serialize
              the envelope, sign the socket mutation, send.
            </li>
            <li>
              Content key: 256-bit, from <code>crypto.getRandomValues</code>,
              one-time per message. It is never stored in cleartext anywhere;
              only its per-recipient OpenPGP wrappings are persisted in{' '}
              <code>encrypted_for_json</code>.
            </li>
            <li>
              IV: 12 bytes, one-time per message, stored in the clear inside the
              envelope as required by GCM.
            </li>
            <li>
              Recipient keys: persistent <code>RSA-2048</code> OpenPGP keypairs,
              one per account and shared across servers.
            </li>
            <li>
              Envelope shape: <code>version</code> = <code>msg-v2</code>,{' '}
              <code>iv</code>, <code>ciphertext</code>, and{' '}
              <code>keyEnvelopes</code> keyed by opaque recipient indexes.
            </li>
            <li>
              Legacy fallback: if the payload does not parse as{' '}
              <code>msg-v2</code>, the client decrypts it as a direct OpenPGP
              message, so pre-rework history still opens.
            </li>
            <li>
              Room and identity metadata are hashed with <code>SHA-256</code>{' '}
              and separately encrypted, so the server can index and route
              without reading names.
            </li>
            <li>
              Account transfer packages are OpenPGP-encrypted to the recipient
              and require re-entering the AES password first; server session
              tokens are excluded.
            </li>
          </ul>
        </div>
      </section>
    </main>
  </>
);

export default EncryptionWorkflowPage;
