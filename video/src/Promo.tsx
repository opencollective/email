import React from 'react'
import { springTiming, TransitionSeries } from '@remotion/transitions'
import { fade } from '@remotion/transitions/fade'
import { slide } from '@remotion/transitions/slide'
import { wipe } from '@remotion/transitions/wipe'
import { AbsoluteFill, useVideoConfig } from 'remotion'
import { C } from './theme'
import { Intro } from './scenes/Intro'
import { Claim } from './scenes/Claim'
import { Share } from './scenes/Share'
import { Assign } from './scenes/Assign'
import { Notes } from './scenes/Notes'
import { Agents } from './scenes/Agents'
import { Drafts } from './scenes/Drafts'
import { Outro } from './scenes/Outro'

const cut = springTiming({ config: { damping: 200 }, durationInFrames: 18 })

/** Scene lengths minus the seven 18-frame transitions; keep in sync with the
 *  durations below (Root registers the composition with it). */
export const PROMO_FRAMES = 100 + 200 + 201 + 212 + 157 + 203 + 172 + 150 - 7 * 18

export const Promo: React.FC = () => {
  const { fps } = useVideoConfig()
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <TransitionSeries>
        <TransitionSeries.Sequence name="Intro" durationInFrames={100} premountFor={fps}>
          <Intro />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={wipe({ direction: 'from-bottom' })} timing={cut} />
        <TransitionSeries.Sequence name="Claim" durationInFrames={200} premountFor={fps}>
          <Claim />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={slide({ direction: 'from-right' })} timing={cut} />
        <TransitionSeries.Sequence name="Share" durationInFrames={201} premountFor={fps}>
          <Share />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={slide({ direction: 'from-right' })} timing={cut} />
        <TransitionSeries.Sequence name="Assign" durationInFrames={212} premountFor={fps}>
          <Assign />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={slide({ direction: 'from-right' })} timing={cut} />
        <TransitionSeries.Sequence name="Notes" durationInFrames={157} premountFor={fps}>
          <Notes />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={slide({ direction: 'from-right' })} timing={cut} />
        <TransitionSeries.Sequence name="Agents" durationInFrames={203} premountFor={fps}>
          <Agents />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={slide({ direction: 'from-right' })} timing={cut} />
        <TransitionSeries.Sequence name="Drafts" durationInFrames={172} premountFor={fps}>
          <Drafts />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={cut} />
        <TransitionSeries.Sequence name="Outro" durationInFrames={150} premountFor={fps}>
          <Outro />
        </TransitionSeries.Sequence>
      </TransitionSeries>
    </AbsoluteFill>
  )
}
