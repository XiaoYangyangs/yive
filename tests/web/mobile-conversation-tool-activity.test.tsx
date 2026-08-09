// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'

import { MobileConversationToolActivity } from '../../web/src/mobile/MobileConversationToolActivity.js'

describe('mobile conversation tool activity', () => {
  test('stays collapsed until the user opens the activity summary', () => {
    render(
      <MobileConversationToolActivity
        items={[
          {
            completed_at: 2_200,
            duration_ms: 1_200,
            label: 'apply_patch',
            provider_event_id: 'apply-patch-1',
            sequence: 1,
            source_checkpoint: 10,
            started_at: 1_000,
            status: 'completed',
          },
          {
            completed_at: null,
            duration_ms: null,
            label: 'exec',
            provider_event_id: 'exec-1',
            sequence: 2,
            source_checkpoint: 20,
            started_at: 2_500,
            status: 'running',
          },
          {
            completed_at: 3_100,
            duration_ms: 100,
            label: 'wait',
            provider_event_id: 'wait-1',
            sequence: 3,
            source_checkpoint: 30,
            started_at: 3_000,
            status: 'completed',
          },
        ]}
      />
    )

    const summaryLabel = screen.getByText('工具活动（3）')
    expect(screen.getByText('apply_patch')).not.toBeVisible()
    expect(screen.getByText('exec')).not.toBeVisible()
    expect(screen.getByText('wait')).not.toBeVisible()

    fireEvent.click(summaryLabel)

    expect(screen.getByText('apply_patch')).toBeVisible()
    expect(screen.getByText('exec')).toBeVisible()
    expect(screen.getByText('wait')).toBeVisible()
    expect(screen.getByText('1.2s')).toBeVisible()
  })
})
