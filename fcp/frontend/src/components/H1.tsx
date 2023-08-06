import React from 'react'

type H1Props = {
  children?: React.ReactNode
}

export function H1(props: H1Props) {
  return (
    <h1 className="mb-4 text-2xl font-extrabold leading-none tracking-tight text-gray-900 md:text-3xl lg:text-4xl dark:text-white">
      {props.children}
    </h1>
  )
}
