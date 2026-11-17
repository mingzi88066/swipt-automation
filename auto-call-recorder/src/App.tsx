import { Host, Text, VStack } from "@expo/ui/swift-ui";

export default function App() {
  return (
    <Host style={{ flex: 1 }}>
      <VStack
        alignment="center"
        spacing={12}
        style={{ flex: 1, justifyContent: "center" }}
      >
        <Text style={{ fontSize: 22, fontWeight: "bold" }}>自动通话录音</Text>
        <Text style={{ color: "secondaryLabel", textAlign: "center" }}>
          服务运行时，接打电话会自动点击「通话录音」。
        </Text>
      </VStack>
    </Host>
  );
}
