import React from 'react'
import { Browser, Camera, DESK, Feature, Ring, Swap, THREAD, VIEW_H, VIEW_W, featureUiAt } from '../components/ui'

const TITLE = 'Add *agents* as members of your collective'

export const Agents: React.FC = () => {
  const U = featureUiAt(TITLE)
  return (
    <Feature title={TITLE}>
      <Browser url="collective.email/inbox/commonshub">
        <Swap at={U + 55}
          a={
            <Camera src="shots/members.png" {...DESK} w={VIEW_W} h={VIEW_H}
              keys={[{ f: U, r: [0.2, 0.12, 0.8, 0.5] }, { f: U + 22, r: [0.22, 0.3, 0.6, 0.3] }]}>
              <Ring x={693} y={642} w={2090} h={95} from={U + 24} radius={18} />
            </Camera>
          }
          b={
            <Camera src="shots/thread-full.png" {...THREAD} w={VIEW_W} h={VIEW_H}
              keys={[{ f: U + 55, r: [0.21, 0.2, 0.62, 0.17] }, { f: U + 92, r: [0.21, 0.315, 0.62, 0.15] }]}>
              <Ring x={648} y={1492} w={1665} h={622} from={U + 94} />
            </Camera>
          }
        />
      </Browser>
    </Feature>
  )
}
