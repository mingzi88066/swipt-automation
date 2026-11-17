import { Form, Host, Section, Text, Toggle } from "@expo/ui/swift-ui";
import { useService } from "@swipt/api/swiplet";
import type extension from "./extension";

const statusText: Record<string, string> = {
  starting: "启动中…",
  running: "运行中",
  stopped: "已停止",
  failed: "出错",
};

export default function App() {
  const service = useService<typeof extension>();
  return (
    <Host style={{ flex: 1 }}>
      <Form>
        <Section
          footer={
            service.error !== null ? (
              <Text>{service.error}</Text>
            ) : (
              <Text>
                服务运行时，接打电话会自动点击「更多」→「通话录音」。
              </Text>
            )
          }
        >
          <Toggle
            label="启用自动录音"
            isOn={service.enabled}
            onIsOnChange={(enabled) => service.setEnabled(enabled)}
          />
          <Text>服务状态：{statusText[service.status] ?? service.status}</Text>
        </Section>
      </Form>
    </Host>
  );
}
