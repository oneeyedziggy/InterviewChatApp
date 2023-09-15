//demo page to suss out how api routes work in this version of next
import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({ message: 'Hello from Next.js!' });
}
