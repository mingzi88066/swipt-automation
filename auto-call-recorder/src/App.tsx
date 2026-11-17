import { Text, View } from "@swipt/api/swift-ui";

export default function App() {
  return (
    <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
      <Text style={{ fontSize: 20, fontWeight: "bold" }}>自动通话录音</Text>
      <Text style={{ marginTop: 8, color: "secondaryLabel" }}>
        服务运行时，接打电话会自动点击「通话录音」。
      </Text>
    </View>
  );
}
