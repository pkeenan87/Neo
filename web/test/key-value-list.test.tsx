import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import { KeyValueList } from '../components/KeyValueList'

afterEach(() => cleanup())

describe('KeyValueList', () => {
  it('renders the empty label when entries is empty', () => {
    render(<KeyValueList entries={[]} onChange={() => {}} emptyLabel="Nothing here." />)
    expect(screen.getByText('Nothing here.')).toBeInTheDocument()
  })

  it('renders one row per entry with the entry values in the inputs', () => {
    render(
      <KeyValueList
        entries={[
          { key: 'a', value: '1' },
          { key: 'b', value: '2' },
        ]}
        onChange={() => {}}
      />,
    )

    const keys = screen.getAllByPlaceholderText('key') as HTMLInputElement[]
    const values = screen.getAllByPlaceholderText('value') as HTMLInputElement[]
    expect(keys).toHaveLength(2)
    expect(values).toHaveLength(2)
    expect(keys[0].value).toBe('a')
    expect(values[1].value).toBe('2')
  })

  it('calls onChange with a new entry array when the Add button is clicked', () => {
    const onChange = vi.fn()
    render(
      <KeyValueList
        entries={[{ key: 'a', value: '1' }]}
        onChange={onChange}
        addLabel="Add row"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /add row/i }))
    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenCalledWith([
      { key: 'a', value: '1' },
      { key: '', value: '' },
    ])
  })

  it('calls onChange when removing a row', () => {
    const onChange = vi.fn()
    render(
      <KeyValueList
        entries={[
          { key: 'a', value: '1' },
          { key: 'b', value: '2' },
        ]}
        onChange={onChange}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /remove key 1/i }))
    expect(onChange).toHaveBeenCalledWith([{ key: 'b', value: '2' }])
  })

  it('calls onChange when a key or value is edited', () => {
    const onChange = vi.fn()
    render(
      <KeyValueList entries={[{ key: 'a', value: '1' }]} onChange={onChange} />,
    )

    fireEvent.change(screen.getByPlaceholderText('value'), { target: { value: '99' } })
    expect(onChange).toHaveBeenCalledWith([{ key: 'a', value: '99' }])
  })

  it('honors custom keyLabel in the remove button aria-label', () => {
    render(
      <KeyValueList
        entries={[{ key: 'a', value: '1' }]}
        onChange={() => {}}
        keyLabel="Variable"
      />,
    )
    expect(screen.getByRole('button', { name: /remove variable 1/i })).toBeInTheDocument()
  })
})
