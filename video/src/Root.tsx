import React from 'react'
import { Composition, Folder } from 'remotion'
import './theme'
import { Promo, PROMO_FRAMES } from './Promo'
import { OgImage } from './OgImage'
import { Intro } from './scenes/Intro'
import { Claim } from './scenes/Claim'
import { Share } from './scenes/Share'
import { Assign } from './scenes/Assign'
import { Notes } from './scenes/Notes'
import { Agents } from './scenes/Agents'
import { Drafts } from './scenes/Drafts'
import { Outro } from './scenes/Outro'

export const Root = () => (
  <>
    <Composition id="Promo" component={Promo} durationInFrames={PROMO_FRAMES} fps={30} width={1920} height={1080} />
    <Folder name="Promo-Scenes">
      <Composition id="Intro" component={Intro} durationInFrames={100} fps={30} width={1920} height={1080} />
      <Composition id="Claim" component={Claim} durationInFrames={200} fps={30} width={1920} height={1080} />
      <Composition id="Share" component={Share} durationInFrames={201} fps={30} width={1920} height={1080} />
      <Composition id="Assign" component={Assign} durationInFrames={212} fps={30} width={1920} height={1080} />
      <Composition id="Notes" component={Notes} durationInFrames={157} fps={30} width={1920} height={1080} />
      <Composition id="Agents" component={Agents} durationInFrames={203} fps={30} width={1920} height={1080} />
      <Composition id="Drafts" component={Drafts} durationInFrames={172} fps={30} width={1920} height={1080} />
      <Composition id="Outro" component={Outro} durationInFrames={150} fps={30} width={1920} height={1080} />
    </Folder>
    <Composition id="OgImage" component={OgImage} durationInFrames={1} fps={30} width={1200} height={630} />
  </>
)
