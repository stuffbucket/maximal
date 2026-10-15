import type { Meta, StoryObj } from "@storybook/react-vite";

import { Stack } from "../../../../shell/src/ui/components/Stack";
import { Table, Tbody, Td, Th, Thead, Tr } from "../../../../shell/src/ui/components/Table";

function Block({ label }: { label: string }): JSX.Element {
  return (
    <div className="sb-tokens__row" style={{ borderBottom: 0 }}>
      <span className="sb-tokens__swatch" style={{ background: "var(--surface-control)" }} />
      <span>{label}</span>
    </div>
  );
}

const meta = {
  title: "Components/Layout",
  component: Stack,
  args: { proximity: "section", direction: "vertical", align: "stretch", justify: "start", wrap: false, children: null },
  argTypes: {
    proximity: { control: "inline-radio", options: ["tight", "group", "section", "region", "window"] },
    direction: { control: "inline-radio", options: ["vertical", "horizontal"] },
    align: { control: "inline-radio", options: ["start", "center", "end", "stretch"] },
    justify: { control: "inline-radio", options: ["start", "center", "end", "space-between"] },
    children: { table: { disable: true } },
  },
} satisfies Meta<typeof Stack>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The proximity scale: tight → window. Use the controls to try each. */
export const StackPlayground: Story = {
  name: "Stack",
  render: (args) => (
    <Stack {...args}>
      <Block label="First" />
      <Block label="Second" />
      <Block label="Third" />
    </Stack>
  ),
};

export const TableBasic: Story = {
  name: "Table",
  render: () => (
    <Table>
      <Thead>
        <Tr>
          <Th scope="col">Model</Th>
          <Th scope="col">Requests</Th>
          <Th scope="col">Tokens</Th>
        </Tr>
      </Thead>
      <Tbody>
        <Tr>
          <Td>claude-sonnet-4-5</Td>
          <Td>24</Td>
          <Td>412,880</Td>
        </Tr>
        <Tr>
          <Td>gpt-4o</Td>
          <Td>12</Td>
          <Td>96,301</Td>
        </Tr>
      </Tbody>
    </Table>
  ),
};
