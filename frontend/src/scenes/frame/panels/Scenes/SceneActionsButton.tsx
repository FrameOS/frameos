import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import { CheckIcon, ChevronDownIcon } from '@heroicons/react/24/outline'

import { Button, ButtonProps } from '../../../../components/Button'
import { DropdownMenu } from '../../../../components/DropdownMenu'
import { Spinner } from '../../../../components/Spinner'
import { SceneActionKey, sceneActionsLogic } from './sceneActionsLogic'

export interface SceneActionOption {
  key: SceneActionKey
  label: string
  description?: string
  icon?: JSX.Element
  disabled?: boolean
  /** The action is under way: the button shows a spinner and does not fire again. */
  loading?: boolean
  title?: string
  onRun: () => void
}

interface SceneActionsButtonProps {
  options: SceneActionOption[]
  /** Fallback selection until the user picks one from the dropdown. */
  defaultKey: SceneActionKey
  size?: ButtonProps['size']
  className?: string
}

/**
 * The standard scene action control: a main button that runs the selected
 * action, plus a dropdown listing every available action. Picking an option
 * only arms the button (globally remembered) — clicking the button runs it.
 */
export function SceneActionsButton({ options, defaultKey, size, className }: SceneActionsButtonProps): JSX.Element {
  const { preferredSceneAction } = useValues(sceneActionsLogic)
  const { setPreferredSceneAction } = useActions(sceneActionsLogic)

  const selected =
    options.find((option) => option.key === preferredSceneAction) ??
    options.find((option) => option.key === defaultKey) ??
    options[0]

  return (
    <div className={clsx('inline-flex items-stretch', className)}>
      <Button
        size={size}
        color="primary"
        className="flex items-center gap-2 !rounded-r-none"
        onClick={selected.onRun}
        disabled={selected.disabled || selected.loading}
        aria-busy={selected.loading || undefined}
        title={selected.title}
      >
        {selected.loading ? <Spinner color="white" className="shrink-0" /> : selected.icon}
        {selected.label}
      </Button>
      <DropdownMenu
        buttonColor="primary"
        className="!rounded-l-none border-l border-white/30 !px-1"
        buttonTitle="Choose what this button does"
        buttonAriaLabel="Choose action"
        buttonContent={<ChevronDownIcon className="h-4 w-4 self-center" aria-hidden="true" />}
        items={options.map((option) => ({
          icon: option.icon,
          label: (
            <span className="flex min-w-0 flex-col">
              <span className="flex items-center gap-2 font-medium">
                {option.label}
                {option.key === selected.key ? <CheckIcon className="h-4 w-4 shrink-0" /> : null}
              </span>
              {option.description ? <span className="text-xs opacity-70">{option.description}</span> : null}
            </span>
          ),
          title: option.title,
          disabled: option.disabled,
          onClick: () => {
            setPreferredSceneAction(option.key)
          },
        }))}
      />
    </div>
  )
}
