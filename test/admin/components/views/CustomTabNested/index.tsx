'use client'

import React, { Fragment, useEffect } from 'react'

import { type AdminViewComponent } from '../../../../../packages/payload/src/admin/types'
import { useStepNav } from '../../../../../packages/ui/src/elements/StepNav'
import { customNestedTabViewTitle } from '../../../shared'

const CustomNestedTabView: AdminViewComponent = () => {
  const { setStepNav } = useStepNav()

  // This effect will only run one time and will allow us
  // to set the step nav to display our custom route name

  useEffect(() => {
    setStepNav([
      {
        label: 'Custom Nested View',
      },
    ])
  }, [setStepNav])

  return (
    <Fragment>
      <div
        style={{
          marginTop: 'calc(var(--base) * 2)',
          paddingLeft: 'var(--gutter-h)',
          paddingRight: 'var(--gutter-h)',
        }}
      >
        <h1 id="custom-view-title">{customNestedTabViewTitle}</h1>
        <p>This custom view was added through the Payload config:</p>
        <ul>
          <li>
            <code>components.views[key].Component</code>
          </li>
        </ul>
      </div>
    </Fragment>
  )
}

export default CustomNestedTabView
