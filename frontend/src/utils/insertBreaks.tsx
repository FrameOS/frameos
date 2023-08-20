import React from 'react'

export function insertBreaks(input: string): JSX.Element {
  const segments = input.split(/([:,\/])/)

  // Map over the segments and append the <wbr /> tag after colons or commas
  const elements: JSX.Element[] = segments.map((segment, index) => {
    if (segment === ':' || segment === ',' || segment === '') {
      return (
        <React.Fragment key={index}>
          {segment}
          <wbr />
        </React.Fragment>
      )
    }
    return <React.Fragment key={index}>{segment}</React.Fragment>
  })

  return <>{elements}</>
}
