import React from 'react'
import { Browser, Camera, DESK, Feature, Ring, Swap, VIEW_H, VIEW_W, featureUiAt } from '../components/ui'

const TITLE = 'Prepare *drafts* together'

export const Drafts: React.FC = () => {
  const U = featureUiAt(TITLE)
  return (
    <Feature title={TITLE}>
      <Browser url="collective.email/inbox/commonshub?f=drafts">
        <Swap at={U + 42}
          a={<Camera src="shots/drafts.png" {...DESK} w={VIEW_W} h={VIEW_H} keys={[{ f: U, r: [0, 0, 1, 0.57] }, { f: U + 40, r: [0.15, 0, 0.85, 0.48] }]} />}
          b={
            <Camera src="shots/draft-nl.png" {...DESK} w={VIEW_W} h={VIEW_H}
              keys={[{ f: U + 42, r: [0.15, 0, 0.85, 0.75] }, { f: U + 100, r: [0.21, 0.02, 0.66, 0.58] }]}>
              <Ring x={652} y={344} w={1655} h={180} from={U + 75} />
            </Camera>
          }
        />
      </Browser>
    </Feature>
  )
}
