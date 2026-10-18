[Skip to main content](https://docs.crusoecloud.com/serverless-inference/available-models/#__docusaurus_skipToContent_fallback)

Use $5 in free credits to explore [Serverless Inference](https://console.crusoecloud.com/foundry/serverless-deployments) and [Serverless Fine-Tuning](https://console.crusoecloud.com/foundry/fine-tuning/jobs)

Copy page

On this page

You can use the OpenAI-API compatible endpoint at `api.inference.crusoecloud.com` to access the models below for [Serverless Inference](https://docs.crusoecloud.com/quickstart/getting-started-with-serverless-inference). You can also interact with all of the models using the Intelligence Foundry's [chat interface](https://console.crusoecloud.com/foundry/chat/new). All Meta models provided by Crusoe are "Built with Llama".

For each model's pricing information, see [pricing](https://www.crusoe.ai/cloud/pricing#Serverless-Inference).

| MODEL | PROVIDER | TYPE | CONTEXT LENGTH | LICENSE | ACCEPTABLE USE POLICY |
| --- | --- | --- | --- | --- | --- |
| [deepseek-ai/DeepSeek-V4-Flash](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-0731) | DeepSeek | instruct | 1M | [MIT License](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-0731/blob/main/LICENSE) |  |
| [deepseek-ai/DeepSeek-V4.1-Flash](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash) | DeepSeek | instruct | 1M | [MIT License](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/main/LICENSE) |  |
| [deepseek-ai/DeepSeek-V4-Pro](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro-0813) | DeepSeek | instruct | 1M | [MIT License](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro-0813/blob/main/LICENSE) |  |
| [google/gemma-4-31b-it](https://huggingface.co/google/gemma-4-31B-it) | Google | instruct | 262k | [Apache License 2.0](https://ai.google.dev/gemma/apache_2) |  |
| [nvidia/Nemotron-3-Nano-30B-A3B](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-FP8) | NVIDIA | instruct | 262k | [NVIDIA Nemotron Open Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-nemotron-open-model-license/) | [NVIDIA Acceptable Use Terms](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-nemotron-open-model-license/) |
| [nvidia/Nemotron-3-Nano-Omni-Reasoning-30B-A3B](https://huggingface.co/nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-FP8) | NVIDIA | instruct | 262k | [NVIDIA Open Model Agreement](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-agreement/) |  |
| [nvidia/Nemotron-3-Super-120B-A12B](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8) | NVIDIA | instruct | 262k | [NVIDIA Nemotron Open Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-nemotron-open-model-license/) | [NVIDIA Acceptable Use Terms](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-nemotron-open-model-license/) |
| [nvidia/Nemotron-3-VoiceChat](https://huggingface.co/nvidia/NVIDIA-NemotronLabs-VoiceChat-11B) | NVIDIA | speech-to-speech | 131k | [NVIDIA Software and Model Evaluation License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-software-and-model-evaluation-license/) | [NVIDIA Acceptable Use Terms](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-software-and-model-evaluation-license/) |
| [nvidia/nemotron-3.5-lightning-30b-a3b](https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4) | NVIDIA | instruct | 1M | [NVIDIA Nemotron Open Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-nemotron-open-model-license/) | [NVIDIA Acceptable Use Terms](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-nemotron-open-model-license/) |
| [openai/gpt-oss-120b](https://huggingface.co/openai/gpt-oss-120b) | OpenAI | instruct | 128k | [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0) | [Acceptable Use Policy](https://huggingface.co/openai/gpt-oss-120b/blob/main/USAGE_POLICY) |
| [qwen/Qwen3.8-27B](https://huggingface.co/Qwen/Qwen3.8-27B) | Qwen | instruct | 256k | [Apache License 2.0](https://huggingface.co/Qwen/Qwen3.8-27B/blob/main/LICENSE) | [Apache License 2.0](https://huggingface.co/Qwen/Qwen3.8-27B/blob/main/LICENSE) |
| [zai/GLM-5.3](https://huggingface.co/zai-org/GLM-5.3) | Z.ai | instruct | 1M | [MIT License](https://huggingface.co/zai-org/GLM-5.3/blob/main/LICENSE) |  |
| [zai/GLM-5.3-Flash](https://huggingface.co/zai-org/GLM-5.3-Flash) | Z.ai | instruct | 1M | [MIT License](https://huggingface.co/zai-org/GLM-5.3-Flash/blob/main/LICENSE) |  |

## Migrate from a deprecated model [​](https://docs.crusoecloud.com/serverless-inference/available-models/\#migrate-from-a-deprecated-model "Direct link to Migrate from a deprecated model")

Serverless Inference models have been deprecated on the following dates:

- **October 2, 2026**: Moonshot Kimi K2.6
- **September 12, 2026**: Z.ai GLM-5.1, Z.ai GLM-5.2, DeepSeek V3, Qwen3 235B A22B, and Llama 3.3 70B

To migrate from a deprecated model to a supported model:

1. Update your API calls to use a recommended replacement model from the table below.
2. Test the replacement model in your development environment.

| Deprecated model | Migration path |
| --- | --- |
| Moonshot Kimi K2.6 | [DeepSeek V4 Flash](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-0731) or [Z.ai GLM-5.3](https://huggingface.co/zai-org/GLM-5.3) |
| Z.ai GLM-5.1 | [Z.ai GLM-5.3](https://huggingface.co/zai-org/GLM-5.3) |
| Z.ai GLM-5.2 | [Z.ai GLM-5.3](https://huggingface.co/zai-org/GLM-5.3) |
| DeepSeek V3 | [DeepSeek V4 Pro](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro-0813) or [DeepSeek V4 Flash](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-0731) |
| Qwen3 235B A22B | [DeepSeek V4 Flash](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-0731) or [Qwen 3.8 27B](https://huggingface.co/Qwen/Qwen3.8-27B) |
| Llama 3.3 70B | [DeepSeek V4 Flash](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-0731) |

For the current list of supported models, see [Available models](https://docs.crusoecloud.com/serverless-inference/available-models).

- [Migrate from a deprecated model](https://docs.crusoecloud.com/serverless-inference/available-models/#migrate-from-a-deprecated-model)