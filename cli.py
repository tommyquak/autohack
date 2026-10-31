"""Quick terminal test: uv run cli.py "your task here" """

import asyncio
import sys

from agent import run_agent


async def main(task: str):
    messages = [{"role": "user", "content": task}]
    async for e in run_agent(messages):
        match e["type"]:
            case "text":
                print(e["text"], end="", flush=True)
            case "thinking":
                print(f"\033[2m{e['text']}\033[0m", end="", flush=True)
            case "tool_call":
                print(f"\n\033[36m→ {e['name']}({e['input']})\033[0m")
            case "tool_result":
                print(f"\033[{'31' if e['is_error'] else '32'}m← {e['output'][:300]}\033[0m")
            case "server_tool":
                print(f"\n\033[35m⚙ {e['name']}\033[0m")
            case "error":
                print(f"\n\033[31m✗ {e['text']}\033[0m")
    print()


if __name__ == "__main__":
    asyncio.run(main(" ".join(sys.argv[1:]) or "What time is it in Singapore? Then find one aviation news headline from today."))
