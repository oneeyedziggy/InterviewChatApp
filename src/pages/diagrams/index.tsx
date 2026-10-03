'use client';

import Head from 'next/head';
import Link from 'next/link';
import styles from '../../styles/Diagrams.module.css';

type DiagramLink = {
  href: string;
  title: string;
  description: string;
};

const DIAGRAM_LINKS: DiagramLink[] = [
  {
    href: '/diagrams/auth-workflow',
    title: 'Authentication workflow',
    description:
      'Key generation, password-derived private key storage, invite redemption, PGP challenge-response login, session issuance, server-creation capabilities, and signed socket mutations.',
  },
  {
    href: '/diagrams/encryption-workflow',
    title: 'Message encryption workflow',
    description:
      'The msg-v2 envelope: per-message AES-256-GCM content keys wrapped per recipient with OpenPGP, what the server stores, and the legacy direct-PGP decryption fallback.',
  },
  {
    href: '/diagrams/database',
    title: 'Database schema',
    description:
      'Interactive entity relationship diagram of the per-server SQLite schema, including invites, access grant requests, and the message history trigger.',
  },
];

const DiagramsIndexPage = () => (
  <>
    <Head>
      <title>Architecture Diagrams</title>
    </Head>
    <main className={styles.page}>
      <section className={styles.header}>
        <p className={styles.kicker}>Architecture</p>
        <h1 className={styles.title}>Diagrams</h1>
        <p className={styles.subtitle}>
          Each diagram documents one workflow of the server-blind chat
          architecture. Flow diagrams are rendered client side with Mermaid; the
          database schema uses the interactive GoJS viewer.
        </p>
      </section>

      <section className={styles.shell} aria-label="Available diagrams">
        <div className={styles.cardGrid}>
          {DIAGRAM_LINKS.map((diagram) => (
            <Link
              key={diagram.href}
              href={diagram.href}
              className={styles.linkCard}
            >
              <h2>{diagram.title}</h2>
              <p>{diagram.description}</p>
            </Link>
          ))}
        </div>
      </section>
    </main>
  </>
);

export default DiagramsIndexPage;
