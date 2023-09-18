import { type NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { scryptAsync } from '@noble/hashes/scrypt';

import { mySessionCache, myUserCache } from '../../../cache';

// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
// This salt *should* be pulled from an env var or secret store but that would make handoff for this
// low sec interview app needlessly complex
// I would also not typically use a rotating UUID because that would render a persistent user store useless
// but I needed the uuid lib anyways and rotating is marginally less bad in this instance because
// the salt value is never put into source control
// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
const salt = uuidv4();
const minPasswordLength = 8;
const minUsernameLength = 8;

type DoSuccessProps = {
  NextResponse: typeof NextResponse;
  username: string;
  hashedPassword: string;
  isUserNew?: boolean;
};

const doSuccess = ({
  username,
  hashedPassword,
  isUserNew = false,
}: DoSuccessProps) => {
  const newSessionId = uuidv4();
  // is user is new store theri sessionId
  isUserNew && myUserCache.set(username, hashedPassword);
  // cache their userId, keyed to their sessionId so no one else even CAN post on their behalf
  mySessionCache.set(newSessionId, username);
  return NextResponse.json({ sessionId: newSessionId });
};
const doFailure = (message: string) => {
  return NextResponse.json({ error: message });
};

const delay = (ms: number) => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};
const comparePasswords = async (a: string, b: string) => {
  // introduce small random delay to evade timing attacks
  // not 100% sure this is the appropriate range of delays
  await delay(Math.floor(Math.random() * 100));
  return a === b;
};

export const POST = async (request: NextRequest) => {
  const data = await request.json();

  if (data.username && data.password?.length >= 8) {
    const hashedPW = (
      (await scryptAsync(data.password, salt, {
        N: 2 ** 16,
        r: 8,
        p: 1,
        dkLen: 32,
      })) as Uint8Array
    ).toString();

    // cached vs received passwords not lining up
    if (myUserCache.has(data.username)) {
      // TODO: this might not be the most efficient... might be slightly faster to just try and get it then failout, but this works for now
      const cachedHashedPW = myUserCache.get(data.username) as string;

      if (data.username.length < minUsernameLength) {
        return doFailure(`Username must be at least ${minUsernameLength}`);
      } else if (data.password.length < minPasswordLength) {
        return doFailure(`Password must be at least ${minPasswordLength}`);
      } else if (await comparePasswords(hashedPW, cachedHashedPW)) {
        return doSuccess({
          NextResponse,
          username: data.username,
          hashedPassword: hashedPW,
        });
      } else {
        return doFailure('Invalid Credentials');
      }
    } else {
      return doSuccess({
        NextResponse,
        username: data.username,
        hashedPassword: hashedPW,
        isUserNew: true,
      });
    }
  } else {
    return doFailure('Required parameters missing');
  }
};
