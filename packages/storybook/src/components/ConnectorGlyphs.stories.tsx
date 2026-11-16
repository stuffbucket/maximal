import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  AllowGlyph,
  AskGlyph,
  BlockGlyph,
  CheckGlyph,
  ChevronDownGlyph,
  ChevronGlyph,
  CloseGlyph,
  ConnectorGlyph,
  InformationGlyph,
  MixedGlyph,
  NoticeGlyph,
} from "../../../../shell/src/ui/features/connectors/glyphs";

const meta = {
  title: "Assets/Connector Glyphs",
  component: ConnectorGlyph,
  tags: ["asset"],
  decorators: [(Story) => <div className="sb-asset-glyph"><Story /></div>],
} satisfies Meta<typeof ConnectorGlyph>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Connector: Story = {};
export const Allow: Story = { render: () => <AllowGlyph /> };
export const Ask: Story = { render: () => <AskGlyph /> };
export const Block: Story = { render: () => <BlockGlyph /> };
export const Mixed: Story = { render: () => <MixedGlyph /> };
export const Information: Story = { render: () => <InformationGlyph /> };
export const Notice: Story = { render: () => <NoticeGlyph /> };
export const Check: Story = { render: () => <CheckGlyph /> };
export const Chevron: Story = { render: () => <ChevronGlyph /> };
export const ChevronDown: Story = { render: () => <ChevronDownGlyph /> };
export const Close: Story = { render: () => <CloseGlyph /> };
