## To be implemented:
The game engine has to translate spatial data into words, and the AI has to output words that the game engine can translate back into physical movement.
Here is the step-by-step blueprint for building this architecture:
 1. Build the Game State Manager (The World)
   Must track spatial zones, not just pixel coordinates
   Standard games use X/Y coordinates for movement, but LLMs struggle with raw geometry. Instead, divide your game map into a "node graph." Define specific rooms (e.g., Cafeteria, Weapons) and the hallways connecting them as discrete zones. Your game engine needs to constantly track which node every player is in, the status of tasks in those nodes, and the simulation time.
 2. Serialize the Environment (The Eyes)
   Translating graphics into data
   The game engine must convert what the AI's character "sees" into text format (usually JSON). Every few seconds (or when an event happens), the engine generates a snapshot for each AI:
   * current_location: "Navigation"
   * visible_players: ["Player_2", "Player_5"]
   * valid_moves: ["O2", "Shields", "Weapons"]
   * current_time: "02:45"
 3. Construct the Prompt (The Brain)
   Merging state with persona
   Feed the serialized JSON data into the LLM via API. But don't just send the data—wrap it in a system prompt that gives the AI its context. This prompt should include:
   * The Persona: "You are an Impostor in Among Us. Your goal is to eliminate crewmates secretly."
   * The Rules: "You cannot use vents. You have a 20-second kill cooldown."
   * The History: A running summary of the AI's previous moves and observations so it remembers where it has been.
   * The Current State: The JSON generated in Step 2.
 4. Parse the Action (The Decision)
   Enforcing strict output formatting
   The LLM analyzes the prompt and decides what to do next. To make this usable for your game engine, you must force the LLM to reply in a strict JSON format. For example, the AI might output: {"action": "MOVE", "target": "Shields", "reasoning": "I need to find a lone crewmate away from the group."}
 5. Execute Pathfinding (The Legs)
   Moving the sprite on screen
   Your game engine receives the LLM's JSON response and parses out "target": "Shields". The engine then uses a standard pathfinding algorithm (like A* Search) to calculate the shortest visual route from the AI's current node (Navigation) to the target node (Shields). The engine physically animates the 2D sprite walking along this path.
 6. Advance the Game Loop
   Repeat the cycle
   Once the sprite arrives at the new node, or a set amount of time passes (a "tick"), the game state updates. The system generates a new serialized JSON snapshot, and the loop repeats, constantly querying the LLM for its next move.
