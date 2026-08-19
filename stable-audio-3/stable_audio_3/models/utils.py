import torch
import os

torch._dynamo.config.cache_size_limit = max(64, torch._dynamo.config.cache_size_limit)
# Do NOT set torch._dynamo.config.suppress_errors = True. With it, a failed
# torch.compile of flex_attention on Windows (no Triton) silently falls back
# to SLOW eager flex instead of raising — which bypasses the fast chunked
# SDPA tier in apply_attn's try/except cascade during VAE decode.

# Get torch.compile flag from environment variable ENABLE_TORCH_COMPILE

enable_torch_compile = os.environ.get("ENABLE_TORCH_COMPILE", "0") == "1"

def compile(function, *args, **kwargs):
    
    if enable_torch_compile:
        try:
            return torch.compile(function, *args, **kwargs)
        except RuntimeError:
            return function

    return function
