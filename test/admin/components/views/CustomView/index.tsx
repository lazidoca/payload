import React from 'react'

import { type AdminViewComponent } from '../../../../../packages/payload/src/admin/types'
import { customViewTitle } from '../../../shared'

const CustomView: AdminViewComponent = () => {
  return (
    <div
      style={{
        marginTop: 'calc(var(--base) * 2)',
        paddingLeft: 'var(--gutter-h)',
        paddingRight: 'var(--gutter-h)',
      }}
    >
      <h1 id="custom-view-title">{customViewTitle}</h1>
      <p>This custom view was added through the Payload config:</p>
      <ul>
        <li>
          <code>components.views[key].Component</code>
        </li>
      </ul>
    </div>
  )
}

export default CustomView
