#!/usr/bin/env python3
"""
Creates an animated GIF for LaMetric from a wide PNG image.
The animation pans across the image from left to right.

Usage: python create_icon.py input.png output.gif
"""

import sys
from PIL import Image

def create_panning_gif(
    input_path: str, 
    output_path: str, 
    frame_duration: int = 50,
    hold_start: int = 500,  # Hold at start (ms)
    hold_end: int = 500     # Hold at end (ms)
):
    """
    Create a panning animation GIF from a wide image.
    
    Args:
        input_path: Path to input PNG (must be 8px tall)
        output_path: Path for output GIF
        frame_duration: Duration per frame in milliseconds
        hold_start: How long to hold on the first frame (ms)
        hold_end: How long to hold on the last frame (ms)
    """
    # Load the source image
    img = Image.open(input_path).convert("RGBA")
    
    width, height = img.size
    
    if height != 8:
        print(f"Error: Image must be 8 pixels tall (got {height}px)")
        sys.exit(1)
    
    if width < 8:
        print(f"Error: Image must be at least 8 pixels wide (got {width}px)")
        sys.exit(1)
    
    # Create frames by sliding an 8x8 window across the image
    single_pass_frames = []
    single_pass_durations = []
    
    # Pan from left to right
    for i, x in enumerate(range(width - 7)):  # Stop when window reaches the right edge
        # Crop an 8x8 section
        frame = img.crop((x, 0, x + 8, 8))
        
        # Convert to palette mode for GIF (handle transparency)
        frame_rgb = Image.new("RGBA", (8, 8), (0, 0, 0, 255))
        frame_rgb.paste(frame, (0, 0), frame)
        frame_p = frame_rgb.convert("P", palette=Image.ADAPTIVE)
        
        single_pass_frames.append(frame_p)
        
        # Set duration - hold longer on first and last frames
        if i == 0:
            single_pass_durations.append(hold_start)
        elif x == width - 8:  # Last frame
            single_pass_durations.append(hold_end)
        else:
            single_pass_durations.append(frame_duration)
    
    if not single_pass_frames:
        print("Error: No frames generated")
        sys.exit(1)
    
    # Repeat the animation multiple times
    repeat_count = 3  # Play the animation 3 times
    frames = single_pass_frames * repeat_count
    durations = single_pass_durations * repeat_count
    
    print(f"Created {len(single_pass_frames)} frames x {repeat_count} repeats = {len(frames)} total frames")
    print(f"Hold at start: {hold_start}ms, Hold at end: {hold_end}ms, Frame duration: {frame_duration}ms")
    
    # Save as animated GIF
    frames[0].save(
        output_path,
        save_all=True,
        append_images=frames[1:],
        duration=durations,
        loop=0  # Loop infinitely while frame is displayed
    )
    
    print(f"Saved animated GIF to: {output_path}")
    
    # Also output base64 for LaMetric
    import base64
    with open(output_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    
    print(f"\nBase64 for LaMetric icon:")
    print(f"data:image/gif;base64,{b64[:100]}...")
    print(f"\nFull base64 ({len(b64)} chars) saved to: {output_path}.txt")
    
    with open(f"{output_path}.txt", "w") as f:
        f.write(f"data:image/gif;base64,{b64}")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python create_icon.py input.png output.gif")
        print("\nThe input PNG must be exactly 8 pixels tall.")
        print("The script will pan across the width to create the animation.")
        sys.exit(1)
    
    create_panning_gif(sys.argv[1], sys.argv[2])
