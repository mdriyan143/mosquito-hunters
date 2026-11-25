'use client';
import dynamic from 'next/dynamic';

// The game needs window / canvas / WebAudio, so render it on the client only.
const Game = dynamic(() => import('../components/Game'), { ssr: false });

export default function Page() {
  return <Game />;
}
