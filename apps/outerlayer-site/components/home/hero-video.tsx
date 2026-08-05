"use client"

import { useRef, useState } from "react"

// Click-to-play, never autoplay: the film carries a voiceover, and captions
// are burned in for anyone who watches muted.
export function HeroVideo() {
  const ref = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)

  return (
    <div className="relative overflow-hidden rounded-card border border-rule bg-paper shadow-dialog">
      <video
        ref={ref}
        poster="/lp-poster.jpg"
        preload="metadata"
        controls={playing}
        onEnded={() => setPlaying(false)}
        className="block aspect-video w-full"
      >
        <source src="/lp-video.mp4" type="video/mp4" />
      </video>
      {!playing && (
        <button
          type="button"
          aria-label="Play the film"
          onClick={() => {
            setPlaying(true)
            void ref.current?.play()
          }}
          className="group absolute inset-0 flex items-center justify-center"
        >
          <span className="flex items-center gap-4 rounded-card border border-ink bg-paper px-6 py-4 shadow-dialog transition-transform group-hover:scale-105">
            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-ink">
              <svg viewBox="0 0 16 16" className="ml-0.5 h-6 w-6 fill-paper" aria-hidden="true">
                <path d="M4 2.5v11l9-5.5-9-5.5z" />
              </svg>
            </span>
            <span className="text-left">
              <span className="block text-xl font-semibold leading-tight text-ink">
                Watch the film
              </span>
              <span className="mt-1 block font-mono text-xs text-ink-soft">
                74 seconds · sound on
              </span>
            </span>
          </span>
        </button>
      )}
    </div>
  )
}
